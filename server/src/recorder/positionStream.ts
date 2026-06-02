import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId } from "./state.js";

interface PositionFrame {
  respondedAt: string;
  data: {
    x: number;
    y: number;
    z1: number;
    z2: number;
    r: number;
    hasHomed: boolean;
  };
}

type Row = {
  buildId: number;
  ts: Date;
  x: number;
  y: number;
  z1: number;
  z2: number;
  r: number;
  hasHomed: boolean;
};

const BATCH_SIZE = 500;
const BATCH_MS = 500;

let buffer: Row[] = [];
let flushTimer: NodeJS.Timeout | null = null;

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const o = i * 8;
    placeholders.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`);
    values.push(r.buildId, r.ts, r.x, r.y, r.z1, r.z2, r.r, r.hasHomed);
  }
  await pool.query(
    `INSERT INTO position_hf (build_id, ts, x, y, z1, z2, r, has_homed) VALUES ${placeholders.join(",")}`,
    values,
  );
}

function scheduleFlush(log: FastifyBaseLogger): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flush().catch((err) => log.error({ err }, "position_hf flush failed"));
  }, BATCH_MS);
}

export function startPositionStreamRecorder(log: FastifyBaseLogger): void {
  const wsUrl = config.INOVA_API_BASE_URL
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  void (async () => {
    let backoff = 1000;
    while (true) {
      const url = `${wsUrl}/movement/position/stream`;
      log.info(`position_hf: connecting to ${url}`);
      const closeMsg = await runOnce(url, log);
      log.warn({ closeMsg }, "position_hf stream closed, reconnecting");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  })();
}

function runOnce(url: string, log: FastifyBaseLogger): Promise<string> {
  return new Promise<string>((resolveDone) => {
    const ws = new WebSocket(url);
    ws.on("open", () => log.info("position_hf: open"));
    ws.on("error", (err) => log.error({ err }, "position_hf WS error"));
    ws.on("close", (code, reason) => resolveDone(`code=${code} reason=${reason.toString()}`));
    ws.on("message", (raw) => {
      const buildId = currentBuildId();
      if (buildId === null) return; // not in a build; drop
      try {
        const frame = JSON.parse(raw.toString()) as PositionFrame;
        buffer.push({
          buildId,
          ts: new Date(frame.respondedAt),
          x: frame.data.x,
          y: frame.data.y,
          z1: frame.data.z1,
          z2: frame.data.z2,
          r: frame.data.r,
          hasHomed: frame.data.hasHomed,
        });
        if (buffer.length >= BATCH_SIZE) {
          flush().catch((err) => log.error({ err }, "position_hf flush failed"));
        } else {
          scheduleFlush(log);
        }
      } catch (err) {
        log.warn({ err }, "position_hf frame parse failed");
      }
    });
  });
}
