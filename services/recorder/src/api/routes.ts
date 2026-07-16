import type { FastifyRequest, FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { spoolFilePath } from "../recorder/spool.js";
import type { FrameSpoolLine } from "../recorder/camera.js";
import { getLatestSnapshot } from "../recorder/telemetry.js";
import { recordOperatorAction } from "../recorder/feedback.js";
import { getLatestPrintingStatus } from "../recorder/job.js";
import { addPositionSubscriber, removePositionSubscriber } from "../recorder/positionStream.js";
import { isUpstreamOpen, tripUpstream } from "../recorder/upstreamBreaker.js";
import { currentMemorySample } from "../recorder/memory.js";
import { registerHealthRoutes } from "./health.js";
import { registerKnowledgeRoutes } from "./knowledge.js";
import {
  cancelStopAfterBuild,
  requestStopAfterBuild,
  stopAfterBuildStatus,
} from "../recorder/lifecycle.js";

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        total += s.size;
      }
    }
  } catch {
    /* missing dir or perm: report 0 */
  }
  return total;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket);

  app.get("/healthz", async () => {
    const { rows } = await pool.query<{ now: Date }>("select now()");
    return { ok: true, db_now: rows[0]?.now ?? null };
  });

  app.get("/api/state/current", async () => getLatestSnapshot());
  app.get("/api/job/current", async () => getLatestPrintingStatus());
  // Recorder process memory. Cheap; safe to poll. Used to diagnose the
  // slow heap leak — poll periodically and correlate growth with load.
  app.get("/api/memory", async () => currentMemorySample());

  // Independent-verification health check; drives the "RECORDING / NOT
  // RECORDING" banner in the UI. Does not use getLatestSnapshot() — that would
  // defeat the point of an independent check.
  registerHealthRoutes(app);

  // Build registry + summaries + ASTM for the GUI Builds page (reads the
  // knowledge tables created by sls-sync-reference).
  await registerKnowledgeRoutes(app);

  // Maintenance: ask the recorder to exit cleanly (code 0 — supervisor and
  // systemd both leave it stopped) once the current build has finalized and
  // its spool import has drained. Replaces kill-by-PID for planned windows.
  app.post("/api/admin/stop-after-build", async () => {
    requestStopAfterBuild();
    return stopAfterBuildStatus();
  });
  app.delete("/api/admin/stop-after-build", async () => {
    const wasRequested = cancelStopAfterBuild();
    return { cancelled: wasRequested, ...stopAfterBuildStatus() };
  });
  app.get("/api/admin/stop-after-build", async () => stopAfterBuildStatus());

  app.get("/api/info", async (_req, reply) => {
    if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
      return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
    }
    try {
      const r = await fetch(`${config.INOVA_API_BASE_URL}/info`);
      if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
      return await r.json();
    } catch (err) {
      tripUpstream(config.INOVA_API_BASE_URL);
      const msg = (err as Error)?.message ?? String(err);
      return reply.code(502).send({ error: "upstream unreachable", detail: msg });
    }
  });

  app.get("/api/summary", async () => {
    const { rows } = await pool.query<{
      builds: string;
      telemetry: string;
      events: string;
      frames: string;
      db_size_bytes: string;
    }>(
      `SELECT
         (SELECT count(*) FROM builds)     AS builds,
         (SELECT count(*) FROM telemetry)  AS telemetry,
         (SELECT count(*) FROM events)     AS events,
         (SELECT count(*) FROM frames)     AS frames,
         pg_database_size(current_database()) AS db_size_bytes`,
    );
    const r = rows[0]!;
    const framesSizeBytes = await dirSizeBytes(resolve(config.FRAMES_DIR));
    return {
      builds: Number(r.builds),
      telemetryRows: Number(r.telemetry),
      events: Number(r.events),
      frames: Number(r.frames),
      dbSizeBytes: Number(r.db_size_bytes),
      framesSizeBytes,
    };
  });

  app.get("/api/builds", async () => {
    const { rows } = await pool.query(
      `SELECT id, job_name, phase, started_at, ended_at, notes
       FROM builds ORDER BY started_at DESC LIMIT 50`,
    );
    return rows;
  });

  app.get<{ Params: { id: string } }>("/api/builds/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM builds WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return rows[0];
  });

  app.get<{
    Params: { id: string };
    Querystring: { kind?: string; kinds?: string; fromMs?: string; toMs?: string; limit?: string };
  }>("/api/builds/:id/telemetry", async (req) => {
    const id = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit ?? 1000), 100000);
    const kindList = req.query.kinds
      ? req.query.kinds.split(",")
      : req.query.kind
        ? [req.query.kind]
        : null;
    const fromMs = req.query.fromMs ? new Date(Number(req.query.fromMs)) : null;
    const toMs = req.query.toMs ? new Date(Number(req.query.toMs)) : null;

    const where: string[] = ["build_id = $1"];
    const params: unknown[] = [id];
    if (kindList) {
      params.push(kindList);
      where.push(`kind = ANY($${params.length}::text[])`);
    }
    if (fromMs) {
      params.push(fromMs);
      where.push(`ts >= $${params.length}`);
    }
    if (toMs) {
      params.push(toMs);
      where.push(`ts <= $${params.length}`);
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT ts, sensor_id, kind, value FROM telemetry
       WHERE ${where.join(" AND ")}
       ORDER BY ts ASC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  });

  app.get<{ Params: { id: string } }>("/api/builds/:id/manifest", async (req, reply) => {
    const id = Number(req.params.id);
    const [buildRes, eventsRes, framesRes] = await Promise.all([
      pool.query(`SELECT * FROM builds WHERE id = $1`, [id]),
      pool.query(
        `SELECT id, ts, kind, message, payload FROM events
         WHERE build_id = $1 ORDER BY ts ASC`,
        [id],
      ),
      pool.query(
        `SELECT id, kind, (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms
         FROM frames WHERE build_id = $1 ORDER BY kind, ts ASC`,
        [id],
      ),
    ]);
    if (buildRes.rows.length === 0) return reply.code(404).send({ error: "not found" });

    const framesByKind: Record<string, { id: number; tsMs: number }[]> = {};
    for (const row of framesRes.rows as { id: number; kind: string; ts_ms: string }[]) {
      const kind = row.kind;
      (framesByKind[kind] ??= []).push({ id: Number(row.id), tsMs: Number(row.ts_ms) });
    }

    return {
      build: buildRes.rows[0],
      events: eventsRes.rows,
      framesByKind,
    };
  });

  app.get<{ Params: { id: string } }>("/api/frames/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query<{ path: string; kind: string }>(
      `SELECT path, kind FROM frames WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const row = rows[0]!;
    const ext = row.path.split(".").pop() ?? "bin";
    const mime =
      ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "json" ? "application/json" : "application/octet-stream";
    return reply.type(mime).send(createReadStream(resolve(config.FRAMES_DIR, row.path)));
  });

  // Live playback of the IN-PROGRESS build. Its frame DB rows don't exist yet
  // (the importer writes them post-print), but the image bytes are already on
  // disk and their metadata is in the NVMe spool. We read framesByKind straight
  // from SPOOL_DIR/<id>/frames.ndjson. Once the build ends and the importer
  // renames the spool file to `.imported`, this returns empty frames and the
  // DB-backed /manifest takes over — a clean handoff, no overlap.
  app.get<{ Params: { id: string } }>("/api/builds/:id/spool-manifest", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: "bad id" });
    const buildRes = await pool.query(
      `SELECT id, job_name, phase, started_at, ended_at FROM builds WHERE id = $1`,
      [id],
    );
    if (buildRes.rows.length === 0) return reply.code(404).send({ error: "not found" });

    const framesByKind: Record<string, { tsMs: number; path: string }[]> = {};
    try {
      const content = await readFile(spoolFilePath(id, "frames"), "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        let f: FrameSpoolLine;
        try {
          f = JSON.parse(line) as FrameSpoolLine;
        } catch {
          continue; // tolerate a torn final line mid-append
        }
        (framesByKind[f.kind] ??= []).push({ tsMs: new Date(f.respondedAt).getTime(), path: f.path });
      }
    } catch {
      // No spool file (build not recording, or already imported) → empty frames.
    }
    for (const k of Object.keys(framesByKind)) framesByKind[k]!.sort((a, b) => a.tsMs - b.tsMs);

    return { build: buildRes.rows[0], framesByKind };
  });

  // Serve a spooled frame image by its relative path (as recorded in the frames
  // spool). Confined to FRAMES_DIR/<id>/ to prevent path traversal.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/frames/spool/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      const rel = req.query.path ?? "";
      const buildRoot = resolve(config.FRAMES_DIR, String(id));
      const abs = resolve(config.FRAMES_DIR, rel);
      if (abs !== buildRoot && !abs.startsWith(buildRoot + "/")) {
        return reply.code(400).send({ error: "bad path" });
      }
      try {
        await stat(abs);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const ext = abs.split(".").pop() ?? "bin";
      const mime =
        ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "json" ? "application/json" : "application/octet-stream";
      return reply.type(mime).send(createReadStream(abs));
    },
  );

  // Camera proxy with circuit breaker on the firmware host. During an outage
  // the browser keeps polling at ~24fps × 3 image kinds; without the breaker
  // each poll spawned a fresh socket + threw a TypeError carrying a full
  // multi-line stack which Fastify logged in full, accumulating heap pressure.
  // Now we trip per-host for 2s on any failure and short-circuit subsequent
  // requests so the cost of an outage is bounded.
  const cameraProxy = (path: string, mime: string) => async (_req: unknown, reply: any) => {
    if (isUpstreamOpen(config.INOVA_FIRMWARE_BASE_URL)) {
      return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
    }
    const url = `${config.INOVA_FIRMWARE_BASE_URL}${path}${randomUUID()}`;
    try {
      const r = await fetch(url);
      if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
      return reply.type(mime).send(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      tripUpstream(config.INOVA_FIRMWARE_BASE_URL);
      // Log only the short message — full err includes a multi-line stack
      // string that wedges the log buffer during sustained outages.
      const msg = (err as Error)?.message ?? String(err);
      return reply.code(502).send({ error: "upstream unreachable", detail: msg });
    }
  };

  // Operator calibrations (append-only; latest per kind wins). The web's
  // Align mode POSTs here; feedback.ts reads the same rows for the
  // build_layout/camera_bboxes projection. GET returns the current row.
  app.get<{ Params: { kind: string } }>("/api/calibration/:kind", async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT id, kind, payload, source, note, created_at FROM calibrations
       WHERE kind = $1 ORDER BY id DESC LIMIT 1`,
      [req.params.kind],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "no calibration recorded" });
    return rows[0];
  });
  app.post<{ Params: { kind: string }; Body: { payload?: unknown; source?: string; note?: string } }>(
    "/api/calibration/:kind",
    async (req, reply) => {
      if (!req.body?.payload || typeof req.body.payload !== "object") {
        return reply.code(400).send({ error: "body.payload (object) required" });
      }
      const { rows } = await pool.query(
        `INSERT INTO calibrations (kind, payload, source, note)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [req.params.kind, JSON.stringify(req.body.payload),
         req.body.source ?? null, req.body.note ?? null],
      );
      return rows[0];
    },
  );

  app.get("/api/camera/chamber.jpg", cameraProxy("/api/videocamera/image/", "image/jpeg"));
  app.get("/api/camera/thermal.gif", cameraProxy("/api/bedmatrix/image/", "image/gif"));
  app.get("/api/camera/galvo.png", cameraProxy("/api/plottedimage/", "image/png"));

  app.get("/api/stream", { websocket: true }, (socket) => {
    const interval = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      const snap = getLatestSnapshot();
      if (snap) socket.send(JSON.stringify(snap));
    }, 100);
    socket.on("close", () => clearInterval(interval));
  });

  // Pass-through WS proxies for plugin endpoints. Browser → server → plugin.
  // Lets the browser stay on one origin and survives plugin restarts cleanly.
  const wsBase = config.INOVA_API_BASE_URL.replace(/^http/, "ws");
  const proxyPluginWs = (upstreamPath: string) => (client: WebSocket, req: FastifyRequest) => {
    const qs = new URLSearchParams();
    const query = req.query as Record<string, string | string[]>;
    for (const [k, v] of Object.entries(query)) qs.set(k, String(Array.isArray(v) ? v[0] : v));
    const url = `${wsBase}${upstreamPath}${qs.size ? `?${qs}` : ""}`;
    const upstream = new WebSocket(url);
    upstream.on("message", (data) => {
      if (client.readyState === client.OPEN) client.send(data.toString());
    });
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close());
    client.on("close", () => upstream.close());
    client.on("error", () => upstream.close());
  };

  app.get("/api/temperature/bedmatrix/stream", { websocket: true }, proxyPluginWs("/temperature/bedmatrix/stream"));

  // Chamber camera stream — binary JPEG frames from the plugin's /camera/stream.
  // Uses a separate proxy handler that passes Buffer data through as-is rather
  // than stringifying it (the text-proxy above would corrupt binary payloads).
  app.get("/api/camera/chamber/stream", { websocket: true }, (client, req) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries((req as { query: Record<string, string> }).query))
      qs.set(k, String(v));
    const url = `${wsBase}/camera/stream${qs.size ? `?${qs}` : ""}`;
    const upstream = new WebSocket(url);
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === client.OPEN)
        client.send(data, { binary: isBinary });
    });
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close());
    client.on("close", () => upstream.close());
    client.on("error", () => upstream.close());
  });

  // Position stream uses fan-out from the recorder (not a per-client proxy)
  // because the firmware's PositionChangedHighFrequency AsyncEvent only
  // delivers to the first subscriber. See positionStream.ts comment.
  app.get("/api/movement/position/stream", { websocket: true }, (client) => {
    const send = (rawFrame: string) => {
      if (client.readyState === 1) client.send(rawFrame);
    };
    addPositionSubscriber(send);
    client.on("close", () => removePositionSubscriber(send));
    client.on("error", () => removePositionSubscriber(send));
  });

  // Plotter info + layer command backfill: plain HTTP proxies to the plugin.
  // Used by the frontend on mount to seed the canvas with what's already in
  // the LoggingCodePlotter's in-memory ring buffer.
  // Plugin proxy with the same circuit-breaker pattern keyed on the plugin
  // host (port 5001) — independent of the firmware host (port 80).
  const httpProxy = (upstreamPath: string) => async (_req: unknown, reply: any) => {
    if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
      return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
    }
    try {
      const r = await fetch(`${config.INOVA_API_BASE_URL}${upstreamPath}`);
      if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
      return await r.json();
    } catch (err) {
      tripUpstream(config.INOVA_API_BASE_URL);
      const msg = (err as Error)?.message ?? String(err);
      return reply.code(502).send({ error: "upstream unreachable", detail: msg });
    }
  };
  app.get("/api/plotter/info", httpProxy("/plotter/info"));
  app.get<{ Params: { idx: string }; Querystring: { since?: string } }>(
    "/api/plotter/layer/:idx/commands",
    async (req, reply) => {
      const idx = Number.parseInt(req.params.idx, 10);
      if (!Number.isFinite(idx)) return reply.code(400).send({ error: "bad layer idx" });
      const since = req.query.since ? `?since=${encodeURIComponent(req.query.since)}` : "";
      return httpProxy(`/plotter/layer/${idx}/commands${since}`)(req, reply);
    },
  );

  // Per-object plotter outlines (id + polygon) for the current layer. JSON.
  app.get("/api/plotter/objects", httpProxy("/plotter/objects"));

  // Per-object PNG mask. Forwards on-screen RGBA query params verbatim.
  // Binary response — same circuit-breaker pattern as the JSON httpProxy but
  // streams bytes through with the upstream content-type.
  app.get<{ Params: { id: string }; Querystring: { on?: string; off?: string } }>(
    "/api/plotter/objects/:id/mask.png",
    async (req, reply) => {
      if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
        return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
      }
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad object id" });
      const qs = new URLSearchParams();
      if (req.query.on) qs.set("on", req.query.on);
      if (req.query.off) qs.set("off", req.query.off);
      const url = `${config.INOVA_API_BASE_URL}/plotter/objects/${id}/mask.png${qs.size ? `?${qs}` : ""}`;
      try {
        const r = await fetch(url);
        if (r.status === 404) return reply.code(404).send({ error: "object not found in current layer" });
        if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
        const mime = r.headers.get("content-type") ?? "image/png";
        return reply.type(mime).send(Buffer.from(await r.arrayBuffer()));
      } catch (err) {
        tripUpstream(config.INOVA_API_BASE_URL);
        const msg = (err as Error)?.message ?? String(err);
        return reply.code(502).send({ error: "upstream unreachable", detail: msg });
      }
    },
  );

  // Live nesting state (mesh names, bounds, transforms). Works pre/post-print.
  app.get("/api/job/current/parts", httpProxy("/job/current/parts"));

  // Binary mesh blob (raw bytes) keyed by mesh hash. Byte-passthrough — no
  // JSON envelope, no decoding — so the browser can hand the ArrayBuffer
  // straight to Three.js BufferGeometry.
  app.get<{ Params: { hash: string } }>("/api/printing/meshes/:hash", async (req, reply) => {
    if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
      return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
    }
    try {
      const r = await fetch(`${config.INOVA_API_BASE_URL}/printing/meshes/${encodeURIComponent(req.params.hash)}`);
      if (r.status === 404) return reply.code(404).send({ error: "mesh not found (hash unknown or not mid-print)" });
      if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
      const mime = r.headers.get("content-type") ?? "application/octet-stream";
      return reply.type(mime).send(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      tripUpstream(config.INOVA_API_BASE_URL);
      const msg = (err as Error)?.message ?? String(err);
      return reply.code(502).send({ error: "upstream unreachable", detail: msg });
    }
  });

  // Per-printing-object state (id, name, hash, transform, isExcluded). Only
  // populated during an active print; returns {data: {objects: []}} otherwise.
  app.get("/api/printing/objects", httpProxy("/printing/objects"));

  // Runtime recoater-passes override — how many recoater passes per layer.
  // GET returns current values from both DI handles + the plugin's cache;
  // POST { value: 1..5 | null } sets or clears the override. Takes effect on
  // the NEXT LayerClient.BeginLayer, which fires at the start of each print
  // layer, so the change is visible on the following layer.
  app.get("/api/printing/recoater-passes", httpProxy("/printing/recoater-passes"));
  app.post<{ Body: { value?: number | null } }>(
    "/api/printing/recoater-passes",
    async (req, reply) => {
      if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
        return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
      }
      // Explicitly forward "value: null" for the clear case — undefined would
      // omit the field entirely and the plugin's record binding would treat
      // it as null anyway, but being explicit is cheaper to reason about.
      const value = req.body?.value === undefined ? null : req.body.value;
      try {
        const r = await fetch(`${config.INOVA_API_BASE_URL}/printing/recoater-passes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value }),
        });
        if (r.status === 400) return reply.code(400).send(await r.json());
        if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
        const data = await r.json();
        void recordOperatorAction("recoater_passes", { value }, app.log);
        return data;
      } catch (err) {
        tripUpstream(config.INOVA_API_BASE_URL);
        const msg = (err as Error)?.message ?? String(err);
        return reply.code(502).send({ error: "upstream unreachable", detail: msg });
      }
    },
  );

  // Full-recoat passes override — expands each layer into N full-height
  // recoats (plugin's FullRecoatLayerClient substitution): one normal recoat
  // plus N-1 repeat sweeps at the same bed height. `powder` controls whether
  // repeats feed a fresh full dose (short-feed compensation) or run dry
  // (debris clearing); omitted = leave the sticky setting unchanged.
  // Distinct from recoater-passes, which stages powder delivery WITHIN one
  // recoat sequence. GET also reports replacementActive so the UI can tell
  // whether the LayerClient substitution is actually loaded on the printer.
  app.get(
    "/api/printing/recoater-passes-full",
    httpProxy("/printing/recoater-passes-full"),
  );
  app.post<{ Body: { value?: number | null; powder?: boolean } }>(
    "/api/printing/recoater-passes-full",
    async (req, reply) => {
      if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
        return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
      }
      const value = req.body?.value === undefined ? null : req.body.value;
      const powder = typeof req.body?.powder === "boolean" ? req.body.powder : undefined;
      try {
        const r = await fetch(
          `${config.INOVA_API_BASE_URL}/printing/recoater-passes-full`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ value, powder }),
          },
        );
        if (r.status === 400) return reply.code(400).send(await r.json());
        if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
        const data = await r.json();
        void recordOperatorAction("recoater_passes_full", { value, powder }, app.log);
        return data;
      } catch (err) {
        tripUpstream(config.INOVA_API_BASE_URL);
        const msg = (err as Error)?.message ?? String(err);
        return reply.code(502).send({ error: "upstream unreachable", detail: msg });
      }
    },
  );

  // Generic LayerClientOptions runtime overrides (speeds, shake, powder
  // dosing, Z clearance, delays). GET returns the field list with current
  // values + saved override state; POST takes a partial {values: {name:
  // number|null}} map (null clears). Validation happens plugin-side (field
  // registry with per-field kind/min/max), so 400s pass through.
  app.get("/api/printing/layer-overrides", httpProxy("/printing/layer-overrides"));
  app.post<{ Body: { values?: Record<string, number | null> } }>(
    "/api/printing/layer-overrides",
    async (req, reply) => {
      if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
        return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
      }
      if (!req.body?.values || typeof req.body.values !== "object") {
        return reply.code(400).send({ error: "body.values (object) required" });
      }
      try {
        const r = await fetch(`${config.INOVA_API_BASE_URL}/printing/layer-overrides`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: req.body.values }),
        });
        if (r.status === 400) return reply.code(400).send(await r.json());
        if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
        const data = await r.json();
        void recordOperatorAction("layer_overrides", { values: req.body.values }, app.log);
        return data;
      } catch (err) {
        tripUpstream(config.INOVA_API_BASE_URL);
        const msg = (err as Error)?.message ?? String(err);
        return reply.code(502).send({ error: "upstream unreachable", detail: msg });
      }
    },
  );

  // Print-setup overrides — the firmware's native mid-print tuning channel
  // (IPrintingService.SetupOverrides): phase temperature targets [°C], total
  // laser energy percent, fill energy density, outline energy densities.
  // Reset to empty by the firmware at every print start, so only meaningful
  // during a print. GET includes `defaults` (the running profile's baseline)
  // for UI placeholders. POST takes the same partial {values:{...}} shape as
  // layer-overrides; laserOutlineEnergyDensities takes an array or null.
  app.get("/api/printing/setup-overrides", httpProxy("/printing/setup-overrides"));
  app.post<{ Body: { values?: Record<string, number | number[] | null> } }>(
    "/api/printing/setup-overrides",
    async (req, reply) => {
      if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
        return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
      }
      if (!req.body?.values || typeof req.body.values !== "object") {
        return reply.code(400).send({ error: "body.values (object) required" });
      }
      try {
        const r = await fetch(`${config.INOVA_API_BASE_URL}/printing/setup-overrides`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: req.body.values }),
        });
        if (r.status === 400) return reply.code(400).send(await r.json());
        if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
        const data = await r.json();
        void recordOperatorAction("setup_overrides", { values: req.body.values }, app.log);
        return data;
      } catch (err) {
        tripUpstream(config.INOVA_API_BASE_URL);
        const msg = (err as Error)?.message ?? String(err);
        return reply.code(502).send({ error: "upstream unreachable", detail: msg });
      }
    },
  );

  // Mid-print include/exclude toggle. POST body forwarded as JSON. Same
  // circuit-breaker key as the GETs since both share the plugin host.
  app.post<{ Params: { id: string }; Body: { excluded?: boolean } }>(
    "/api/printing/objects/:id/exclude",
    async (req, reply) => {
      if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
        return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
      }
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad object id" });
      if (typeof req.body?.excluded !== "boolean") {
        return reply.code(400).send({ error: "body.excluded (boolean) required" });
      }
      try {
        const r = await fetch(`${config.INOVA_API_BASE_URL}/printing/objects/${id}/exclude`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ excluded: req.body.excluded }),
        });
        if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
        const data = await r.json();
        void recordOperatorAction("exclude_part", { object_id: id, excluded: req.body.excluded }, app.log);
        return data;
      } catch (err) {
        tripUpstream(config.INOVA_API_BASE_URL);
        const msg = (err as Error)?.message ?? String(err);
        return reply.code(502).send({ error: "upstream unreachable", detail: msg });
      }
    },
  );

  // Print profile CRUD — thin proxy to the plugin's /profiles/* routes.
  // Profiles are bare JSON (no {respondedAt,data} envelope); status codes
  // pass through: 200/201/204 for success, 400 for bad input, 404 not found.
  //
  // Generic helper: forward method + body to the plugin and relay the reply.
  // Keyed on the plugin circuit breaker, same as the other plugin routes.
  const pluginProxy = async (
    method: string,
    path: string,
    body: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reply: any,
  ): Promise<unknown> => {
    if (isUpstreamOpen(config.INOVA_API_BASE_URL)) {
      return reply.code(502).send({ error: "upstream unreachable (breaker open)" });
    }
    try {
      const opts: RequestInit = { method };
      if (body !== undefined && method !== "DELETE" && method !== "GET") {
        opts.headers = { "content-type": "application/json" };
        opts.body = JSON.stringify(body);
      }
      const r = await fetch(`${config.INOVA_API_BASE_URL}${path}`, opts);
      if (r.status === 204) return reply.code(204).send();
      const payload: unknown = await r.json().catch(() => ({ status: r.status }));
      // Surface 400/404 to the client directly; everything else non-2xx → 502.
      const code = r.ok
        ? r.status
        : r.status === 400 || r.status === 404
          ? r.status
          : 502;
      return reply.code(code).send(payload);
    } catch (err) {
      tripUpstream(config.INOVA_API_BASE_URL);
      const msg = (err as Error)?.message ?? String(err);
      return reply.code(502).send({ error: "upstream unreachable", detail: msg });
    }
  };

  app.get("/api/profiles", (_req, reply) =>
    pluginProxy("GET", "/profiles", undefined, reply),
  );

  app.get<{ Params: { id: string }; Querystring: { merged?: string } }>(
    "/api/profiles/:id",
    (req, reply) => {
      const qs = req.query.merged === "true" ? "?merged=true" : "";
      return pluginProxy("GET", `/profiles/${encodeURIComponent(req.params.id)}${qs}`, undefined, reply);
    },
  );

  app.post<{ Body: Record<string, unknown> }>("/api/profiles", (req, reply) =>
    pluginProxy("POST", "/profiles", req.body, reply),
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/profiles/:id",
    (req, reply) =>
      pluginProxy("PUT", `/profiles/${encodeURIComponent(req.params.id)}`, req.body, reply),
  );

  app.delete<{ Params: { id: string } }>("/api/profiles/:id", (req, reply) =>
    pluginProxy("DELETE", `/profiles/${encodeURIComponent(req.params.id)}`, undefined, reply),
  );

  // Powder tuning session commands — thin proxies to the plugin's /powder-tuning/* routes.
  // The session must be started from the firmware wizard; these endpoints control it once running.
  app.get("/api/powder-tuning/status", (_req, reply) =>
    pluginProxy("GET", "/powder-tuning/status", undefined, reply));
  app.post<{ Body: Record<string, unknown> }>("/api/powder-tuning/layer", (req, reply) =>
    pluginProxy("POST", "/powder-tuning/layer", req.body, reply));
  app.post<{ Body: Record<string, unknown> }>("/api/powder-tuning/bed-level", (req, reply) =>
    pluginProxy("POST", "/powder-tuning/bed-level", req.body, reply));
  app.post<{ Body: Record<string, unknown> }>("/api/powder-tuning/surface", (req, reply) =>
    pluginProxy("POST", "/powder-tuning/surface", req.body, reply));
  app.post<{ Body: Record<string, unknown> }>("/api/powder-tuning/params", (req, reply) =>
    pluginProxy("POST", "/powder-tuning/params", req.body, reply));
  app.get("/api/powder-tuning/print/setup", (_req, reply) =>
    pluginProxy("GET", "/powder-tuning/print/setup", undefined, reply));
  app.post<{ Body: Record<string, unknown> }>("/api/powder-tuning/print", (req, reply) =>
    pluginProxy("POST", "/powder-tuning/print", req.body, reply));
  app.post("/api/powder-tuning/stop", (_req, reply) =>
    pluginProxy("POST", "/powder-tuning/stop", undefined, reply));

  // Job CRUD — thin proxy to the plugin's /jobs/* routes. Same circuit-breaker
  // key as the other plugin routes. Jobs are bare JSON (no {respondedAt,data}
  // envelope). PATCH /jobs/:id accepts { name?, printProfileId? }.
  app.get("/api/jobs", (_req, reply) =>
    pluginProxy("GET", "/jobs", undefined, reply),
  );

  app.get<{ Params: { id: string } }>("/api/jobs/:id", (req, reply) =>
    pluginProxy("GET", `/jobs/${encodeURIComponent(req.params.id)}`, undefined, reply),
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; printProfileId?: string } }>(
    "/api/jobs/:id",
    (req, reply) =>
      pluginProxy("PATCH", `/jobs/${encodeURIComponent(req.params.id)}`, req.body, reply),
  );

  app.delete<{ Params: { id: string } }>("/api/jobs/:id", (req, reply) =>
    pluginProxy("DELETE", `/jobs/${encodeURIComponent(req.params.id)}`, undefined, reply),
  );
}
