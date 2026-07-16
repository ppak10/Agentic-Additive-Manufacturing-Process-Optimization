import type { FastifyBaseLogger } from "fastify";

// Periodic memory sampler + optional auto-shutdown guard. The recorder has
// a slow monotonic leak (heap grew to 4GB and later 8GB before OOM'ing),
// most likely in WebSocket subscriber lists or camera-proxy buffers. Until
// that's tracked down properly, this band-aid samples memory every 30s and
// — when the guard is enabled and heap crosses a soft threshold — cleanly
// initiates shutdown so an external supervisor can restart with a fresh
// heap. Better than a hard OOM (releases DB connections, closes Fastify,
// distinguishes memory-triggered restart from clean exit via exit code).
//
// Guard is opt-in via RECORDER_MEMORY_GUARD=1. Rationale: under `tsx watch`
// (the default dev workflow) there is no supervisor, so exiting just kills
// the process. The `server/scripts/run-recorder.sh` wrapper sets the env var and
// handles restart.

const SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_SOFT_THRESHOLD_FRACTION = 0.9;
export const MEMORY_GUARD_EXIT_CODE = 101;

// Parses --max-old-space-size (in MB) from NODE_OPTIONS. Returns null when
// no cap is set; in that case the sampler still logs but the guard is off.
function readMaxHeapMB(): number | null {
  const nodeOpts = process.env.NODE_OPTIONS ?? "";
  const m = nodeOpts.match(/--max-old-space-size=(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

export function startMemoryMonitor(
  log: FastifyBaseLogger,
  onSoftLimit: () => void | Promise<void>,
): void {
  const guardEnabled = process.env.RECORDER_MEMORY_GUARD === "1";
  const maxHeapMB = readMaxHeapMB();
  const softThresholdMB =
    guardEnabled && maxHeapMB ? Math.floor(maxHeapMB * DEFAULT_SOFT_THRESHOLD_FRACTION) : null;

  log.info(
    { guardEnabled, maxHeapMB, softThresholdMB },
    softThresholdMB
      ? "memory monitor started (guard armed)"
      : guardEnabled
        ? "memory monitor started (guard requested but no --max-old-space-size found — sampling only)"
        : "memory monitor started (guard disabled — sampling only)",
  );

  let triggered = false;
  const tick = () => {
    const m = process.memoryUsage();
    const heapMB = Math.round(m.heapUsed / (1024 * 1024));
    const rssMB = Math.round(m.rss / (1024 * 1024));
    const extMB = Math.round(m.external / (1024 * 1024));
    log.info({ heapUsedMB: heapMB, rssMB, externalMB: extMB }, "memory sample");

    if (softThresholdMB !== null && heapMB > softThresholdMB && !triggered) {
      triggered = true;
      log.error(
        { heapUsedMB: heapMB, softThresholdMB, maxHeapMB },
        "heap crossed soft threshold — initiating graceful shutdown for supervisor restart",
      );
      void Promise.resolve(onSoftLimit()).catch((err) =>
        log.error({ err }, "onSoftLimit handler threw"),
      );
    }
  };
  tick();
  setInterval(tick, SAMPLE_INTERVAL_MS).unref();
}

// Returns a snapshot for exposure via /api/memory. Cheap; safe to call
// per-request.
export function currentMemorySample(): {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
  arrayBuffersMB: number;
  maxHeapMB: number | null;
} {
  const m = process.memoryUsage();
  const round = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return {
    heapUsedMB: round(m.heapUsed),
    heapTotalMB: round(m.heapTotal),
    rssMB: round(m.rss),
    externalMB: round(m.external),
    arrayBuffersMB: round(m.arrayBuffers),
    maxHeapMB: readMaxHeapMB(),
  };
}
