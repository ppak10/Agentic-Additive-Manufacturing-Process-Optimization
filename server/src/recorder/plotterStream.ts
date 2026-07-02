import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import { config } from "../config.js";
import { currentBuildId, isShuttingDown } from "./state.js";
import { appendSpool, noteFrame } from "./spool.js";

// Mirror of the plugin's CommandFrame data envelope (camelCase per its
// JsonSerializerDefaults.Web options).
export interface CommandFrame {
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
      noteFrame("plotter");

      const buildId = currentBuildId();
      if (buildId === null) return; // not in a build; skip spooling
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
      } catch {
        /* epoch tracking is best-effort; the importer validates each line */
      }
      // Raw frame verbatim onto the NVMe spool — imported into
      // plotter_commands after the build ends.
      appendSpool("plotter", buildId, rawStr);
    });
  });
}
