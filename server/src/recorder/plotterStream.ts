import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId, isShuttingDown } from "./state.js";

// Mirror of the plugin's CommandFrame data envelope (camelCase per its
// JsonSerializerDefaults.Web options).
interface CommandFrame {
  respondedAt: string;
  data: {
    buildEpoch: string;
    layer: number;
    idx: number;
    ts: string;
    op: string;
    x: number | null;
    y: number | null;
    laser: number | null;
    speed: number | null;
    raw: string | null;
  };
}

type Row = {
  buildId: number;
  ts: Date;
  layerIdx: number;
  cmdIdx: number;
  op: string;
  x: number | null;
  y: number | null;
  laser: number | null;
  speed: number | null;
  raw: string | null;
};

// Tighter than position_hf — commands burst higher than the ~1 kHz HF position
// stream during a dense raster, and a smaller flush window keeps the dashboard
// backfill query fresh enough for "what happened in the last few seconds".
const BATCH_SIZE = 1000;
const BATCH_MS = 250;

let buffer: Row[] = [];
let flushTimer: NodeJS.Timeout | null = null;

// Last seen buildEpoch — change indicates the plugin restarted mid-print or a
// new print began. We log a warning but keep writing; benign cmd_idx overlap
// in the table is documented in schema.sql.
let lastBuildEpoch: string | null = null;

// Live subscribers (WS clients on /api/plotter/commands/stream). Same
// recorder-owned single-subscription pattern as positionStream.ts — the
// firmware's bounded-channel subscriber model still works per-client, but
// using fan-out keeps the architecture symmetric and means one server→plugin
// WS regardless of dashboard count.
type LiveSubscriber = (rawFrame: string) => void;
const liveSubscribers = new Set<LiveSubscriber>();

export function addPlotterSubscriber(handler: LiveSubscriber): void {
  liveSubscribers.add(handler);
}

export function removePlotterSubscriber(handler: LiveSubscriber): void {
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
    const o = i * 10;
    placeholders.push(
      `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`,
    );
    values.push(r.buildId, r.ts, r.layerIdx, r.cmdIdx, r.op, r.x, r.y, r.laser, r.speed, r.raw);
  }
  await pool.query(
    `INSERT INTO plotter_commands (build_id, ts, layer_idx, cmd_idx, op, x, y, laser, speed, raw) VALUES ${placeholders.join(",")}`,
    values,
  );
}

function scheduleFlush(log: FastifyBaseLogger): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flush().catch((err) => log.error({ err }, "plotter_commands flush failed"));
  }, BATCH_MS);
}

export function startPlotterStreamRecorder(log: FastifyBaseLogger): void {
  const wsUrl = config.INOVA_API_BASE_URL
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  void (async () => {
    let backoff = 1000;
    while (true) {
      const url = `${wsUrl}/plotter/commands/stream`;
      log.info(`plotter_commands: connecting to ${url}`);
      const closeMsg = await runOnce(url, log);
      log.warn({ closeMsg }, "plotter_commands stream closed, reconnecting");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  })();
}

function runOnce(url: string, log: FastifyBaseLogger): Promise<string> {
  return new Promise<string>((resolveDone) => {
    const ws = new WebSocket(url);
    ws.on("open", () => log.info("plotter_commands: open"));
    ws.on("error", (err) => log.error({ msg: (err as Error)?.message ?? String(err) }, "plotter_commands WS error"));
    ws.on("close", (code, reason) => resolveDone(`code=${code} reason=${reason.toString()}`));
    ws.on("message", (raw) => {
      const rawStr = raw.toString();

      // Fan out to live subscribers regardless of build state so the trace tab
      // keeps drawing even when no build is active (e.g. operator-initiated
      // movement testing).
      broadcast(rawStr);

      const buildId = currentBuildId();
      if (buildId === null) return; // not in a build; skip DB write
      if (isShuttingDown()) return;
      try {
        const frame = JSON.parse(rawStr) as CommandFrame;
        if (lastBuildEpoch !== null && lastBuildEpoch !== frame.data.buildEpoch) {
          log.warn(
            { prev: lastBuildEpoch, next: frame.data.buildEpoch },
            "plotter_commands: buildEpoch changed mid-recording; cmd_idx will reset",
          );
        }
        lastBuildEpoch = frame.data.buildEpoch;
        buffer.push({
          buildId,
          ts: new Date(frame.data.ts),
          layerIdx: frame.data.layer,
          cmdIdx: frame.data.idx,
          op: frame.data.op,
          x: frame.data.x,
          y: frame.data.y,
          laser: frame.data.laser,
          speed: frame.data.speed,
          raw: frame.data.raw,
        });
        if (buffer.length >= BATCH_SIZE) {
          flush().catch((err) => log.error({ err }, "plotter_commands flush failed"));
        } else {
          scheduleFlush(log);
        }
      } catch (err) {
        log.warn({ err }, "plotter_commands frame parse failed");
      }
    });
  });
}
