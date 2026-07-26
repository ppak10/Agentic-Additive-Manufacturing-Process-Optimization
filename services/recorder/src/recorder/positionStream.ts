import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import { config } from "../config.js";
import { currentBuildId, isShuttingDown, isFramesRecording } from "./state.js";
import { appendSpool, noteFrame } from "./spool.js";

export interface PositionFrame {
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
      noteFrame("position");

      const buildId = currentBuildId();
      if (buildId === null || !isFramesRecording()) return; // only during "Layers"
      if (isShuttingDown()) return;
      // Raw frame verbatim onto the NVMe spool — imported into position_hf
      // after the build ends. At ~1 kHz this stream is exactly the write
      // volume the SMR-backed DB couldn't absorb live.
      appendSpool("position", buildId, rawStr);
    });
  });
}
