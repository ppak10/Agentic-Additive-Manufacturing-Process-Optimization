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
  // live verdicts double as curated training labels (correct→positive,
  // incorrect→negative; 'ignored' is deliberately neither)
  for (const [cls, v] of classes) {
    if (v !== "correct" && v !== "incorrect") continue;
    await pool
      .query(
        `INSERT INTO defect_labels (build_id, layer, ts, class, bbox, polarity, source, defect_event_id)
         VALUES ($1, $2, now(), $3, $4, $5, 'live', $6)`,
        [orig.build_id, orig.payload.layer ?? null, cls, blob?.bbox ?? null,
         v === "correct" ? "positive" : "negative", eventId],
      )
      .catch((err) => log(`label insert failed: ${err.message}`));
  }
  log(`feedback on event ${eventId}: ${summary}`);
  return { ok: true };
}

// ---- replay inference + labels CRUD (Telemetry dataset lab) ----------------

// Mock inference on ARCHIVED frames: fetch each frame image from the
// recorder by id, ship to the model server, return the verdict WITHOUT
// writing a defect_detection event — replay scoring is an analysis act,
// not telemetry.
async function replayInference(body: {
  build_id?: number;
  chamber_frame_ids?: number[];
  galvo_frame_ids?: number[];
  prev_scan_frame_id?: number | null;
}): Promise<{ status: number; json: unknown }> {
  const chamberIds = body.chamber_frame_ids ?? [];
  if (chamberIds.length === 0) return { status: 400, json: { error: "chamber_frame_ids required" } };
  const fetchFrame = async (id: number): Promise<string | null> => {
    try {
      const r = await fetch(`${RECORDER_BASE_URL}/api/frames/${id}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer()).toString("base64");
    } catch {
      return null;
    }
  };
  const chamber = (await Promise.all(chamberIds.map(fetchFrame))).filter((x): x is string => x !== null);
  const galvo = (await Promise.all((body.galvo_frame_ids ?? []).map(fetchFrame))).filter(
    (x): x is string => x !== null,
  );
  const prev = body.prev_scan_frame_id != null ? await fetchFrame(body.prev_scan_frame_id) : null;
  if (chamber.length === 0) return { status: 404, json: { error: "no archived frames found for those ids" } };
  const r = await fetch(`${DEFECT_MODEL_URL}/infer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      build_id: body.build_id ?? null,
      layer: null,
      chamber_frames: chamber,
      galvo_frames: galvo,
      prev_scan_frame: prev,
    }),
    signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
  });
  if (!r.ok) return { status: 502, json: { error: `model server ${r.status}` } };
  return { status: 200, json: { ...(await r.json()) as object, frames_used: { chamber: chamber.length, galvo: galvo.length, prev: prev != null } } };
}

async function listLabels(buildId: number) {
  const { rows } = await pool.query(
    `SELECT id, build_id, layer, ts, frame_ids, class, bbox, polarity, status,
            source, defect_event_id, note, created_at, updated_at
     FROM defect_labels WHERE build_id = $1 ORDER BY id DESC`,
    [buildId],
  );
  return rows;
}

async function createLabel(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const { build_id, layer, ts, frame_ids, bbox, polarity, source, note } = body;
  const cls = body.class;
  if (!build_id || !cls || !polarity || !source) {
    return { status: 400, json: { error: "build_id, class, polarity, source required" } };
  }
  if (!["positive", "negative"].includes(String(polarity))) {
    return { status: 400, json: { error: "polarity must be positive|negative" } };
  }
  const { rows } = await pool.query(
    `INSERT INTO defect_labels (build_id, layer, ts, frame_ids, class, bbox, polarity, source, defect_event_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [build_id, layer ?? null, ts ?? null, frame_ids ?? null, cls, bbox ?? null,
     polarity, source, body.defect_event_id ?? null, note ?? null],
  );
  return { status: 200, json: rows[0] };
}

async function patchLabel(id: number, body: { status?: string; note?: string }): Promise<{ status: number; json: unknown }> {
  if (body.status && !["active", "rejected"].includes(body.status)) {
    return { status: 400, json: { error: "status must be active|rejected" } };
  }
  const { rows } = await pool.query(
    `UPDATE defect_labels SET
       status = coalesce($2, status),
       note = coalesce($3, note),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, body.status ?? null, body.note ?? null],
  );
  if (rows.length === 0) return { status: 404, json: { error: "no such label" } };
  return { status: 200, json: rows[0] };
}

// ---- anomaly triage queue (Labeling page) -----------------------------------
// Candidates come from sls-analyze-build (CV suspicion sort); the human
// dismisses or labels them. Labeling creates a defect_labels row and back-
// links it on the candidate.

async function listAnomalies(params: URLSearchParams) {
  const where: string[] = [];
  const vals: unknown[] = [];
  const status = params.get("status") ?? "pending";
  vals.push(status);
  where.push(`status = $${vals.length}`);
  const buildId = params.get("build_id");
  if (buildId) {
    vals.push(Number(buildId));
    where.push(`build_id = $${vals.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, build_id, layer, frame_id, ts, bbox, score, method, status, label_id
     FROM anomaly_candidates WHERE ${where.join(" AND ")}
     ORDER BY build_id DESC, frame_id, score DESC LIMIT 5000`,
    vals,
  );
  return rows;
}

async function patchAnomaly(id: number, body: { status?: string; label_id?: number }) {
  if (body.status && !["pending", "dismissed", "labeled"].includes(body.status)) {
    return { status: 400, json: { error: "bad status" } };
  }
  const { rows } = await pool.query(
    `UPDATE anomaly_candidates SET
       status = coalesce($2, status),
       label_id = coalesce($3, label_id),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, body.status ?? null, body.label_id ?? null],
  );
  if (rows.length === 0) return { status: 404, json: { error: "no such candidate" } };
  return { status: 200, json: rows[0] };
}

async function dismissAnomalies(ids: number[]) {
  if (!Array.isArray(ids) || ids.length === 0) return { status: 400, json: { error: "ids required" } };
  const { rowCount } = await pool.query(
    `UPDATE anomaly_candidates SET status='dismissed', updated_at=now()
     WHERE id = ANY($1::bigint[]) AND status='pending'`,
    [ids],
  );
  return { status: 200, json: { dismissed: rowCount } };
}

// Neighboring chamber frames around a flagged frame — the triage page's
// context scrubber (is that debris real, or a lighting flicker on ONE
// frame?). Returns ids ordered by time with the center index.
async function frameContext(params: URLSearchParams) {
  const frameId = Number(params.get("frame_id"));
  const span = Math.min(25, Number(params.get("span")) || 10);
  if (!Number.isFinite(frameId)) return { status: 400, json: { error: "frame_id required" } };
  const { rows: center } = await pool.query<{ build_id: string; ts: Date }>(
    `SELECT build_id, ts FROM frames WHERE id = $1`, [frameId],
  );
  if (!center[0]) return { status: 404, json: { error: "no such frame" } };
  const { build_id, ts } = center[0];
  const [before, after] = await Promise.all([
    pool.query<{ id: string }>(
      `SELECT id FROM frames WHERE build_id=$1 AND kind='chamber' AND ts < $2
       ORDER BY ts DESC LIMIT $3`, [build_id, ts, span],
    ),
    pool.query<{ id: string }>(
      `SELECT id FROM frames WHERE build_id=$1 AND kind='chamber' AND ts > $2
       ORDER BY ts ASC LIMIT $3`, [build_id, ts, span],
    ),
  ]);
  const ids = [
    ...before.rows.map((r) => Number(r.id)).reverse(),
    frameId,
    ...after.rows.map((r) => Number(r.id)),
  ];
  return { status: 200, json: { ids, center: before.rows.length } };
}

// ---- tiny HTTP surface --------------------------------------------------------
// "/defect/*" aliases are the same endpoints reached through the web proxy
// (vite maps /defect -> :3200 without stripping the prefix).
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/^\/defect(?=\/|$)/, "") || "/";
  const send = (status: number, json: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(json));
  };
  void (async () => {
    try {
      if (req.method === "POST" && path === "/feedback") {
        const result = await recordDefectFeedback(await readBody(req));
        return send(result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && path === "/replay") {
        const r = await replayInference(await readBody(req));
        return send(r.status, r.json);
      }
      if (req.method === "GET" && path === "/frames/context") {
        const r = await frameContext(url.searchParams);
        return send(r.status, r.json);
      }
      if (req.method === "GET" && path === "/anomalies") {
        return send(200, await listAnomalies(url.searchParams));
      }
      if (req.method === "PATCH" && /^\/anomalies\/\d+$/.test(path)) {
        const id = Number(path.split("/")[2]);
        const r = await patchAnomaly(id, (await readBody(req)) as { status?: string; label_id?: number });
        return send(r.status, r.json);
      }
      if (req.method === "POST" && path === "/anomalies/dismiss") {
        const r = await dismissAnomalies(((await readBody(req)) as { ids?: number[] }).ids ?? []);
        return send(r.status, r.json);
      }
      if (req.method === "GET" && path === "/labels") {
        const buildId = Number(url.searchParams.get("build_id"));
        if (!Number.isFinite(buildId)) return send(400, { error: "build_id required" });
        return send(200, await listLabels(buildId));
      }
      if (req.method === "POST" && path === "/labels") {
        const r = await createLabel(await readBody(req));
        return send(r.status, r.json);
      }
      if (req.method === "PATCH" && /^\/labels\/\d+$/.test(path)) {
        const id = Number(path.split("/")[2]);
        const r = await patchLabel(id, (await readBody(req)) as { status?: string; note?: string });
        return send(r.status, r.json);
      }
      if (req.method === "GET" && path === "/health") {
        return send(200, {
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
        });
      }
      if (req.method === "GET" && path === "/latest") {
        return send(200, latest);
      }
      return send(404, { error: "not found" });
    } catch (err) {
      return send(500, { error: (err as Error).message });
    }
  })();
});

server.listen(PORT, () => log(`defect bridge listening on :${PORT} → ${DEFECT_MODEL_URL}`));
void pollHealth().then(() => {
  setInterval(pollHealth, 5000);
  setInterval(sampleTick, SAMPLE_MS);
  watchStream();
});
