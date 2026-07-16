// Defect-detection bridge (:3200) — client of the v05 model server on MAIL-10.
//
// The model runs REMOTELY (serve.py, GPU): this service only watches the
// recorder's layer clock, ships frames out, and records what comes back.
// Advisory semantics: results are notify-only; nothing here touches the
// printer. Losing MAIL-10 must never affect recording — every remote call
// is caught and logged, never rethrown into the loop.
//
// Per layer:  z2 step on /api/stream closes the previous layer's frame
// buffer → POST {chamber_frames, galvo_frames, prev_scan_frame} to /infer
// (the engine picks recoat/scan frames by quality itself) → INSERT INTO
// events (kind='defect_detection') + cache for GET /defect/latest.
// v05 has no plotter_commands input — the scan mask is derived from the
// accumulated galvo frames server-side.

import http from "node:http";
import pg from "pg";
import WebSocket from "ws";

const RECORDER_BASE_URL = process.env.RECORDER_BASE_URL ?? "http://127.0.0.1:3000";
const DEFECT_MODEL_URL = process.env.DEFECT_MODEL_URL ?? "http://128.2.112.20:8100";
const PORT = Number(process.env.DEFECT_PORT ?? 3200);
const SAMPLE_MS = 2000; // chamber/galvo grab cadence while printing
const MAX_FRAMES = 16; // per-layer buffer cap; decimate to keep even spread
const INFER_TIMEOUT_MS = 60_000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

type InferResult = {
  scores: Record<string, number>;
  alerts: string[]; // class names over threshold
  sources?: Record<string, string>;
  maps_png?: Record<string, string>;
  quality?: Record<string, number | boolean>;
  latency_ms?: number;
};

type LatestDefect = {
  buildId: number | null;
  layer: number;
  z2: number;
  ts: string;
  // events row id of the defect_detection insert — the handle operator
  // feedback (confirm/reject) references.
  eventId: number | null;
  framesUsed: { chamber: number; galvo: number; prevScan: boolean };
  result: InferResult;
  // verdicts already submitted for this event (cls → confirm|reject),
  // echoed so the GUI can render feedback state across polls.
  feedback: Record<string, string>;
};

// ---- shared state ----------------------------------------------------------
let recording = false;
let buildId: number | null = null;
let phase: string | null = null;
let layer = 0; // z2-step count since service start (not the firmware surface index)
let lastZ2: number | null = null;
let latest: LatestDefect | null = null;
let lastError: string | null = null;
let modelReachable: boolean | null = null;
let inferInFlight = false;

let chamberBuf: Buffer[] = [];
let galvoBuf: Buffer[] = [];
let prevScanFrame: Buffer | null = null;

function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

// ---- recording health poll -------------------------------------------------
async function pollHealth() {
  try {
    const r = await fetch(`${RECORDER_BASE_URL}/api/health/recording`, {
      signal: AbortSignal.timeout(5000),
    });
    const h = (await r.json()) as {
      overall?: string;
      firmware?: { phase?: string; is_printing?: boolean };
      build?: { current_build_id?: string | null };
    };
    recording = h.overall === "RECORDING";
    phase = h.firmware?.phase ?? null;
    const id = h.build?.current_build_id;
    buildId = id != null ? Number(id) : null;
  } catch {
    recording = false;
  }
}

// ---- frame sampling ---------------------------------------------------------
async function grab(path: string): Promise<Buffer | null> {
  try {
    const r = await fetch(`${RECORDER_BASE_URL}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

function push(buf: Buffer[], frame: Buffer): Buffer[] {
  buf.push(frame);
  // Decimate instead of truncating so the kept frames still span the whole
  // layer window (the engine needs both a recoat-ish and a scan-ish frame).
  if (buf.length > MAX_FRAMES) buf = buf.filter((_, i) => i % 2 === 0);
  return buf;
}

// Infer only while layers are printing — the firmware's phase name is
// "Layers" (NOT "Printing"; caught live when build 47 entered the phase).
// Heating/BedPreparation frames are out of the training distribution and
// alert at 0.7-0.98 on pristine powder (observed on build 47 bed prep —
// every layer false-alerted).
function inPrintingPhase(): boolean {
  return recording && phase === "Layers";
}

async function sampleTick() {
  if (!inPrintingPhase()) return;
  const [chamber, galvo] = await Promise.all([
    grab("/api/camera/chamber.jpg"),
    grab("/api/camera/galvo.png"),
  ]);
  if (chamber) chamberBuf = push(chamberBuf, chamber);
  if (galvo) galvoBuf = push(galvoBuf, galvo);
}

// ---- layer clock ------------------------------------------------------------
function watchStream() {
  const ws = new WebSocket(`${RECORDER_BASE_URL.replace(/^http/, "ws")}/api/stream`);
  ws.on("message", (data) => {
    try {
      const snap = JSON.parse(data.toString()) as { data?: { position?: { z2?: number } } };
      const z2 = snap.data?.position?.z2;
      if (typeof z2 !== "number") return;
      if (lastZ2 !== null && z2 > lastZ2 && inPrintingPhase()) {
        void onLayerStep(z2);
      }
      lastZ2 = z2;
    } catch {
      /* malformed snapshot — skip */
    }
  });
  ws.on("close", () => setTimeout(watchStream, 3000));
  ws.on("error", () => ws.close());
}

async function onLayerStep(z2: number) {
  layer += 1;
  const chamber = chamberBuf;
  const galvo = galvoBuf;
  chamberBuf = [];
  galvoBuf = [];
  if (chamber.length < 2) return; // nothing meaningful buffered yet
  if (inferInFlight) {
    log(`layer ${layer}: skipped, previous inference still in flight`);
    return;
  }
  inferInFlight = true;
  try {
    await runInference(chamber, galvo, z2);
  } finally {
    inferInFlight = false;
    // Last buffered frame of the completed layer is the best cheap proxy for
    // "previous scan frame" (the engine re-ranks by quality server-side).
    prevScanFrame = chamber[chamber.length - 1] ?? prevScanFrame;
  }
}

// ---- inference + persistence -------------------------------------------------
async function runInference(chamber: Buffer[], galvo: Buffer[], z2: number) {
  const body = {
    build_id: buildId,
    layer,
    chamber_frames: chamber.map((b) => b.toString("base64")),
    galvo_frames: galvo.map((b) => b.toString("base64")),
    prev_scan_frame: prevScanFrame?.toString("base64") ?? null,
  };
  let result: InferResult;
  try {
    const r = await fetch(`${DEFECT_MODEL_URL}/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`model server ${r.status}`);
    result = (await r.json()) as InferResult;
    modelReachable = true;
    lastError = null;
  } catch (err) {
    modelReachable = false;
    lastError = (err as Error)?.message ?? String(err);
    log(`layer ${layer}: inference failed — ${lastError}`);
    return;
  }

  const alerted = result.alerts ?? [];
  const message =
    alerted.length > 0
      ? `layer ${layer}: ALERT ${alerted.map((k) => `${k}=${result.scores?.[k]?.toFixed(2)}`).join(", ")}`
      : `layer ${layer}: clear (max ${Math.max(...Object.values(result.scores ?? { none: 0 })).toFixed(2)})`;
  log(message);

  latest = {
    buildId,
    layer,
    z2,
    ts: new Date().toISOString(),
    eventId: null,
    framesUsed: { chamber: chamber.length, galvo: galvo.length, prevScan: prevScanFrame != null },
    result: {
      ...result,
      // Anomaly maps are bulky base64 PNGs — keep only the classes that fired.
      maps_png: Object.fromEntries(
        Object.entries(result.maps_png ?? {}).filter(([k]) => alerted.includes(k)),
      ),
    },
    feedback: {},
  };

  if (buildId == null) return;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, 'defect_detection', $2, $3) RETURNING id`,
      [
        buildId,
        message,
        JSON.stringify({
          layer,
          z2,
          scores: result.scores,
          alerts: result.alerts,
          sources: result.sources,
          quality: result.quality,
          latency_ms: result.latency_ms,
          frames_used: latest.framesUsed,
          maps_png: latest.result.maps_png,
        }),
      ],
    );
    if (latest) latest.eventId = rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    lastError = `events insert failed: ${(err as Error).message}`;
    log(lastError);
  }
}

// ---- operator feedback on verdicts ------------------------------------------
// The human-loop label channel. Three-state per class (user, 2026-07-16):
//   correct     — the detection is real
//   ignored     — seen but deliberately not acted on; NEITHER a positive
//                 nor a negative label (don't let "I ignored it" poison
//                 either class at training time)
//   incorrect   — the detection is wrong (a clean negative label)
// Each verdict becomes a defect_feedback events row referencing the
// original defect_detection event — together with the tick-aligned frames
// around the event's ts, that is a training label for Inova fine-tuning.
const VERDICTS = new Set(["correct", "ignored", "incorrect"]);

// Blob-scoped feedback (2026-07-16): a verdict may target one connected
// region of a class's anomaly map instead of the whole frame — the GUI
// sends the blob's geometry (map-space, normalized 0..1) and a stable key.
// Blob verdicts are tracked under that key in latest.feedback so the GUI
// can mark the specific blob answered without closing out the class.
type FeedbackBlob = {
  key: string; // `${class}@${cx},${cy}` — GUI-computed, stable per map
  class: string;
  bbox: [number, number, number, number];
  centroid: [number, number];
  area_px: number;
  peak: number;
};

async function recordDefectFeedback(body: {
  event_id?: number;
  verdicts?: Record<string, string>;
  note?: string;
  blob?: FeedbackBlob;
}): Promise<{ ok: boolean; error?: string }> {
  const eventId = body.event_id;
  const verdicts = body.verdicts ?? {};
  const classes = Object.entries(verdicts).filter(([, v]) => VERDICTS.has(v));
  if (!eventId || classes.length === 0) return { ok: false, error: "event_id and verdicts required" };
  const { rows } = await pool.query<{ build_id: string | null; payload: Record<string, unknown> }>(
    `SELECT build_id, payload FROM events WHERE id = $1 AND kind = 'defect_detection'`,
    [eventId],
  );
  const orig = rows[0];
  if (!orig) return { ok: false, error: `defect_detection event ${eventId} not found` };
  const blob = body.blob ?? null;
  const summary =
    classes.map(([c, v]) => `${c}=${v}`).join(", ") +
    (blob ? ` [blob @ ${blob.centroid.map((v) => v.toFixed(2)).join(",")}]` : "");
  await pool.query(
    `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, 'defect_feedback', $2, $3)`,
    [
      orig.build_id,
      `operator: ${summary}`,
      JSON.stringify({
        source: "gui",
        defect_event_id: eventId,
        verdicts: Object.fromEntries(classes),
        // region-scoped label: geometry in normalized map coords (= the
        // full chamber frame). Null = whole-frame verdict.
        blob,
        note: body.note ?? null,
        // scores/alerts/layer copied so the label row is self-contained;
        // maps + frames resolve via defect_event_id / tick timestamps.
        original: {
          layer: orig.payload.layer,
          z2: orig.payload.z2,
          scores: orig.payload.scores,
          alerts: orig.payload.alerts,
        },
      }),
    ],
  );
  if (latest?.eventId === eventId) {
    // blob verdicts key by blob; whole-frame verdicts key by class
    const entries = blob
      ? Object.fromEntries(classes.map(([, v]) => [blob.key, v]))
      : Object.fromEntries(classes);
    latest.feedback = { ...latest.feedback, ...entries };
  }
  log(`feedback on event ${eventId}: ${summary}`);
  return { ok: true };
}

// ---- tiny HTTP surface --------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  // "/defect/*" aliases are the same endpoints reached through the web
  // proxy (vite maps /defect → :3200 without stripping the prefix).
  if (req.method === "POST" && (req.url === "/feedback" || req.url === "/defect/feedback")) {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          const result = await recordDefectFeedback(body);
          res.statusCode = result.ok ? 200 : 400;
          res.end(JSON.stringify(result));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      })();
    });
    return;
  }
  if (req.url === "/health" || req.url === "/defect/health") {
    res.end(
      JSON.stringify({
        status: "ok",
        model_url: DEFECT_MODEL_URL,
        model_reachable: modelReachable,
        recording,
        build_id: buildId,
        phase,
        layer,
        buffered: { chamber: chamberBuf.length, galvo: galvoBuf.length },
        last_error: lastError,
        last_result_ts: latest?.ts ?? null,
      }),
    );
  } else if (req.url === "/defect/latest") {
    res.end(JSON.stringify(latest));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }
});

server.listen(PORT, () => log(`defect bridge listening on :${PORT} → ${DEFECT_MODEL_URL}`));
void pollHealth().then(() => {
  setInterval(pollHealth, 5000);
  setInterval(sampleTick, SAMPLE_MS);
  watchStream();
});
