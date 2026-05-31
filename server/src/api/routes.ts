import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { getLatestSnapshot } from "../recorder/telemetry.js";
import { getLatestPrintingStatus } from "../recorder/job.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket);

  app.get("/healthz", async () => {
    const { rows } = await pool.query<{ now: Date }>("select now()");
    return { ok: true, db_now: rows[0]?.now ?? null };
  });

  app.get("/api/state/current", async () => getLatestSnapshot());
  app.get("/api/job/current", async () => getLatestPrintingStatus());

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

  app.get<{ Params: { id: string }; Querystring: { kind?: string; limit?: string } }>(
    "/api/builds/:id/telemetry",
    async (req) => {
      const id = Number(req.params.id);
      const limit = Math.min(Number(req.query.limit ?? 1000), 10000);
      if (req.query.kind) {
        const { rows } = await pool.query(
          `SELECT ts, sensor_id, kind, value FROM telemetry
           WHERE build_id = $1 AND kind = $2 ORDER BY ts DESC LIMIT $3`,
          [id, req.query.kind, limit],
        );
        return rows;
      }
      const { rows } = await pool.query(
        `SELECT ts, sensor_id, kind, value FROM telemetry
         WHERE build_id = $1 ORDER BY ts DESC LIMIT $2`,
        [id, limit],
      );
      return rows;
    },
  );

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

  const cameraProxy = (path: string, mime: string) => async (_req: unknown, reply: any) => {
    const url = `${config.INOVA_FIRMWARE_BASE_URL}${path}${randomUUID()}`;
    const r = await fetch(url);
    if (!r.ok) return reply.code(502).send({ error: "upstream", status: r.status });
    return reply.type(mime).send(Buffer.from(await r.arrayBuffer()));
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
}
