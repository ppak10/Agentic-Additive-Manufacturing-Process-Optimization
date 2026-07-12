import type { FastifyBaseLogger } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { config } from "../config.js";
import { currentBuildId, isShuttingDown } from "./state.js";
import { isUpstreamOpen, tripUpstream } from "./upstreamBreaker.js";
import { appendSpool } from "./spool.js";

type Kind = "chamber" | "thermal" | "galvo";

// Shape of one line in the frames spool — consumed by importer.ts.
export interface FrameSpoolLine {
  respondedAt: string;
  kind: string;
  path: string;
}

// Galvo PNG + chamber fallback: HTTP-polled until the new plugin (which exposes
// /camera/stream WebSocket) is deployed to the printer. Once deployed, remove
// the chamber entry here and rely solely on startChamberRecorder below.
interface Source {
  kind: Extract<Kind, "chamber" | "galvo">;
  hz: number;
  url(): string;
  ext: string;
}

const SOURCES: Source[] = [
  {
    kind: "chamber",
    get hz() { return config.GALVO_HZ; }, // reuse GALVO_HZ as a reasonable rate
    url: () => `${config.INOVA_FIRMWARE_BASE_URL}/api/videocamera/image/${randomUUID()}`,
    ext: "jpg",
  },
  {
    kind: "galvo",
    get hz() { return config.GALVO_HZ; },
    url: () => `${config.INOVA_FIRMWARE_BASE_URL}/api/plottedimage/${randomUUID()}`,
    ext: "png",
  },
];

// Per-source warn rate limit. We log every Nth identical failure so an
// outage doesn't flood the log with thousands of stack-trace-bearing lines.
const FAIL_LOG_EVERY = 20;
const failCounts: Record<Kind, number> = { chamber: 0, thermal: 0, galvo: 0 };

async function captureOne(source: Source, buildId: number, log: FastifyBaseLogger): Promise<void> {
  // Skip the fetch entirely if the firmware host's breaker is open. Without
  // this the recorder hammers a downed firmware at full rate, mirroring the
  // browser-side fetch storm.
  if (isUpstreamOpen(config.INOVA_FIRMWARE_BASE_URL)) return;
  try {
    const r = await fetch(source.url());
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer());
    const ts = new Date();
    const filename = `${ts.getTime()}_${source.kind}.${source.ext}`;
    const relPath = `${buildId}/${filename}`;
    const absPath = resolve(config.FRAMES_DIR, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, buf);
    if (isShuttingDown()) return;
    // Metadata goes to the NVMe spool, not the DB — the frames row is
    // INSERTed by the importer after the build ends.
    const line: FrameSpoolLine = { respondedAt: ts.toISOString(), kind: source.kind, path: relPath };
    appendSpool("frames", buildId, JSON.stringify(line));
    failCounts[source.kind] = 0;
  } catch (err) {
    if (isShuttingDown()) return;
    tripUpstream(config.INOVA_FIRMWARE_BASE_URL);
    failCounts[source.kind]++;
    if (failCounts[source.kind] % FAIL_LOG_EVERY === 1) {
      // Log only the message, not the err object — Fastify/pino would
      // serialize the full stack which adds up under sustained outages.
      const msg = (err as Error)?.message ?? String(err);
      log.warn(
        { kind: source.kind, n: failCounts[source.kind], msg },
        "frame capture failed",
      );
    }
  }
}

// Chamber camera: subscribe to the plugin's /camera/stream WebSocket instead of
// polling the firmware's one-shot HTTP endpoint. The plugin subscribes to
// ICameraClient.Captured inside the firmware process and pushes raw JPEG bytes as
// binary WebSocket frames — same data, zero extra round-trips to the firmware.
// Each binary message is a complete JPEG; we save it directly to disk.
export function startChamberRecorder(log: FastifyBaseLogger): void {
  const wsUrl = config.INOVA_API_BASE_URL
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  void (async () => {
    let backoff = 1000;
    while (true) {
      const url = `${wsUrl}/camera/stream`;
      log.info(`chamber: connecting to ${url}`);
      const closed = await runChamberOnce(url, log);
      if (isShuttingDown()) return;
      log.warn({ closed }, "chamber stream closed, reconnecting");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  })();
}

function runChamberOnce(url: string, log: FastifyBaseLogger): Promise<string> {
  return new Promise<string>((resolveDone) => {
    const ws = new WebSocket(url);
    ws.on("open", () => log.info("chamber: open"));
    ws.on("error", (err) => log.error({ msg: (err as Error)?.message ?? String(err) }, "chamber WS error"));
    ws.on("close", (code, reason) => resolveDone(`code=${code} reason=${reason.toString()}`));
    ws.on("message", async (raw) => {
      const buildId = currentBuildId();
      if (buildId === null) return; // not in a build; drop frame
      if (isShuttingDown()) return;
      try {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const ts = new Date();
        const filename = `${ts.getTime()}_chamber.jpg`;
        const relPath = `${buildId}/${filename}`;
        const absPath = resolve(config.FRAMES_DIR, relPath);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, buf);
        const line: FrameSpoolLine = { respondedAt: ts.toISOString(), kind: "chamber", path: relPath };
        appendSpool("frames", buildId, JSON.stringify(line));
      } catch (err) {
        log.warn({ err }, "chamber frame write failed");
      }
    });
  });
}

export function startCameraRecorder(log: FastifyBaseLogger): void {
  for (const source of SOURCES) {
    void (async () => {
      // Target-time scheduling: the next capture is anchored to `nextAt`, not
      // to `previousFinish + period`. Prevents drift when fetch latency is a
      // large fraction of the period (which happens at higher target rates —
      // the pre-fix "sleep after work" gave ~4 Hz when configured for 5 Hz,
      // and would have gotten worse as we bumped rates).
      let nextAt = Date.now();
      while (true) {
        const buildId = currentBuildId();
        if (buildId !== null) {
          await captureOne(source, buildId, log);
        }
        const period = 1000 / source.hz;
        nextAt += period;
        const now = Date.now();
        // If we fell behind by more than one whole period (slow fetch, GC pause,
        // paused build, etc.), re-anchor to now instead of firing back-to-back
        // "catch-up" captures.
        if (nextAt < now - period) nextAt = now;
        const wait = Math.max(0, nextAt - now);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
  }
}
