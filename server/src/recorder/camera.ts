import type { FastifyBaseLogger } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
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

interface Source {
  kind: Kind;
  hz: number;
  url(): string;
  ext: string;
}

const SOURCES: Source[] = [
  {
    kind: "chamber",
    get hz() { return config.CAMERA_HZ; },
    url: () => `${config.INOVA_FIRMWARE_BASE_URL}/api/videocamera/image/${randomUUID()}`,
    ext: "jpg",
  },
  {
    kind: "thermal",
    get hz() { return config.THERMAL_HZ; },
    url: () => `${config.INOVA_FIRMWARE_BASE_URL}/api/bedmatrix/image/${randomUUID()}`,
    ext: "gif",
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
