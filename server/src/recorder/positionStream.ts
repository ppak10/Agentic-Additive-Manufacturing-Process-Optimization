import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId, isShuttingDown } from "./state.js";

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

// Live subscribers (WS clients on /api/movement/position/stream). The firmware's
// PositionChangedHighFrequency event only delivers to the first AsyncEvent
// subscriber — so the per-client pass-through proxy pattern doesn't work for
// this stream. Instead, the recorder owns the sole subscription to the plugin
// and fans incoming frames out here. Bedmatrix doesn't need this; only position.
type LiveSubscriber = (rawFrame: string) => void;
const liveSubscribers = new Set<LiveSubscriber>();

export function addPositionSubscriber(handler: LiveSubscriber): void {
  liveSubscribers.add(handler);
}

export function removePositionSubscriber(handler: LiveSubscriber): void {
  liveSubscribers.delete(handler);
}

function broadcast(rawFrame: string): void {
  for (const handler of liveSubscribers) {
    try {
      handler(rawFrame);
    } catch {
      /* one bad subscriber shouldn't break the others */
    }
  }
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  if (isShuttingDown()) return;
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
    ws.on("error", (err) => log.error({ msg: (err as Error)?.message ?? String(err) }, "position_hf WS error"));
    ws.on("close", (code, reason) => resolveDone(`code=${code} reason=${reason.toString()}`));
    ws.on("message", (raw) => {
      const rawStr = raw.toString();

      // Fan out to live WS subscribers regardless of build state so the
      // GalvoPlotTile keeps drawing even when no build is active.
      broadcast(rawStr);

      const buildId = currentBuildId();
      if (buildId === null) return; // not in a build; skip DB write
      if (isShuttingDown()) return;
      try {
        const frame = JSON.parse(rawStr) as PositionFrame;
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
