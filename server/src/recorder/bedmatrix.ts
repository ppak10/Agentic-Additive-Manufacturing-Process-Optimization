import type { FastifyBaseLogger } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import WebSocket from "ws";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId } from "./state.js";

interface BedMatrixFrame {
  respondedAt: string;
  data: {
    timestamp: { timestamp: number; totalSeconds: number; elapsedFromNow: string };
    width: number;
    height: number;
    values: number[];
  };
}

// Server-side decimation: ask the plugin for at most this rate. The firmware
// camera native rate is ~6 Hz; 1 Hz keeps disk growth ~90 MB per 8-hour build.
const TARGET_HZ = 1;

export function startBedMatrixRecorder(log: FastifyBaseLogger): void {
  const wsUrl = config.INOVA_API_BASE_URL
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  void (async () => {
    let backoff = 1000;
    while (true) {
      const url = `${wsUrl}/temperature/bedmatrix/stream?hz=${TARGET_HZ}`;
      log.info(`bedmatrix: connecting to ${url}`);
      const closed = await runOnce(url, log);
      log.warn({ closed }, "bedmatrix stream closed, reconnecting");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  })();
}

function runOnce(url: string, log: FastifyBaseLogger): Promise<string> {
  return new Promise<string>((resolveDone) => {
    const ws = new WebSocket(url);
    ws.on("open", () => log.info("bedmatrix: open"));
    ws.on("error", (err) => log.error({ err }, "bedmatrix WS error"));
    ws.on("close", (code, reason) => resolveDone(`code=${code} reason=${reason.toString()}`));
    ws.on("message", async (raw) => {
      const buildId = currentBuildId();
      if (buildId === null) return; // not in a build; drop
      try {
        const frame = JSON.parse(raw.toString()) as BedMatrixFrame;
        const ts = new Date(frame.respondedAt);
        const filename = `${ts.getTime()}_bedmatrix.json`;
        const relPath = `${buildId}/${filename}`;
        const absPath = resolve(config.FRAMES_DIR, relPath);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(
          absPath,
          JSON.stringify({
            ts: frame.respondedAt,
            width: frame.data.width,
            height: frame.data.height,
            values: frame.data.values,
          }),
        );
        await pool.query(
          `INSERT INTO frames (build_id, ts, kind, path) VALUES ($1, $2, $3, $4)`,
          [buildId, ts, "bedmatrix", relPath],
        );
      } catch (err) {
        log.warn({ err }, "bedmatrix frame write failed");
      }
    });
  });
}
