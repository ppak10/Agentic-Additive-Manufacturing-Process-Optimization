import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { getLatestSnapshot } from "../recorder/telemetry.js";
import { getLatestPrintingStatus } from "../recorder/job.js";
import { addPositionSubscriber, removePositionSubscriber } from "../recorder/positionStream.js";
import { addPlotterSubscriber, removePlotterSubscriber } from "../recorder/plotterStream.js";
import { isUpstreamOpen, tripUpstream } from "../recorder/upstreamBreaker.js";

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
    const mime = ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "application/octet-stream";
    return reply.type(mime).send(createReadStream(resolve(config.FRAMES_DIR, row.path)));
  });

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
  const proxyPluginWs = (upstreamPath: string) => (client: WebSocket, req: { query: Record<string, string | string[]> }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) qs.set(k, String(Array.isArray(v) ? v[0] : v));
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

  // Plotter command stream — same fan-out pattern as position. Frames flow
  // from the LoggingCodePlotter decorator in the plugin.
  app.get("/api/plotter/commands/stream", { websocket: true }, (client) => {
    const send = (rawFrame: string) => {
      if (client.readyState === 1) client.send(rawFrame);
    };
    addPlotterSubscriber(send);
    client.on("close", () => removePlotterSubscriber(send));
    client.on("error", () => removePlotterSubscriber(send));
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

  // Post-build / Postgres-backed command backfill. Serves the recorded log
  // for a specific build+layer; used for replay and frame-to-command
  // correlation analysis. Limit capped to keep response sizes bounded.
  app.get<{
    Params: { id: string };
    Querystring: { layer?: string; sinceCmdIdx?: string; limit?: string };
  }>("/api/builds/:id/plotter/commands", async (req, reply) => {
    const buildId = Number.parseInt(req.params.id, 10);
    const layer = Number.parseInt(req.query.layer ?? "0", 10);
    const since = Number.parseInt(req.query.sinceCmdIdx ?? "0", 10);
    const limit = Math.min(Number.parseInt(req.query.limit ?? "10000", 10), 50000);
    if (!Number.isFinite(buildId) || !Number.isFinite(layer) || !Number.isFinite(since) || !Number.isFinite(limit)) {
      return reply.code(400).send({ error: "bad query" });
    }
    const { rows } = await pool.query(
      `SELECT ts, layer_idx, cmd_idx, op, x, y, laser, speed, raw
         FROM plotter_commands
        WHERE build_id = $1 AND layer_idx = $2 AND cmd_idx >= $3
        ORDER BY cmd_idx ASC
        LIMIT $4`,
      [buildId, layer, since, limit],
    );
    return { buildId, layer, sinceCmdIdx: since, limit, commands: rows };
  });
}
