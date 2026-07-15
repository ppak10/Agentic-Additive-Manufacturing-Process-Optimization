import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId, isShuttingDown } from "../recorder/state.js";
import { getSpoolStats, SPOOL_STREAMS, type SpoolStream } from "../recorder/spool.js";
import { getImporterStatus, type ImporterStatus } from "../recorder/importer.js";

// "Recording" is measured against the NVMe spool, entirely in memory — NOT
// against MAX(ts) in Postgres. The old DB-lag check was itself the flapping
// bug: under print-time write load on the SMR disk the healthy baseline sat
// at ~2.5–3.0 s against a 3 s budget (and the MAX(ts) probes took 10–20 s,
// piling more load on the pool they were measuring). Spool appends complete
// in microseconds, so lag here means the upstream frames stopped or the
// spool disk is failing — the two things this banner exists to catch.
//
// Telemetry is polled at 10 Hz → a fresh append every 100 ms; 3 s is 30× the
// interval, generous enough to smooth over one dropped poll cycle without
// hiding a real recorder failure.
const TELEMETRY_MAX_LAG_MS = 3_000;
// A spool write error is alarming for this long after it fires.
const SPOOL_ERROR_FRESH_MS = 10_000;
const FIRMWARE_POLL_TIMEOUT_MS = 2_000;
const STARTUP_GRACE_MS = 10_000;

const SERVER_STARTED_AT = Date.now();
let lastState: RecordingState | null = null;

export type RecordingState =
  | "RECORDING"
  | "IDLE"
  | "PRINTING_NOT_RECORDING"
  | "PRINTER_UNREACHABLE"
  | "STARTING_UP";

interface SpoolStreamHealth {
  // Last frame received from the plugin/firmware (any build state).
  frame_lag_ms: number | null;
  // Last line appended to the spool (only advances during a build).
  append_lag_ms: number | null;
  lines: number;
  last_error: { at_ms: number; message: string } | null;
}

export interface HealthResult {
  overall: RecordingState;
  reason: string;
  timestamp_ms: number;
  firmware: {
    reachable: boolean;
    phase: string | null;
    is_printing: boolean;
    error?: string;
  };
  build: {
    current_build_id: number | null;
  };
  spool: Record<SpoolStream, SpoolStreamHealth>;
  importer: ImporterStatus | null;
  budgets: {
    telemetry_max_lag_ms: number;
  };
}

// Fresh HTTP hits to the firmware, deliberately NOT using getLatestSnapshot()
// from the telemetry worker or getLatestPrintingStatus() from the job worker.
// If either worker is stuck, its cache is stale — asking the worker "are you
// healthy?" is exactly the check that would have missed the 21-hour outage.
// These are the same firmware endpoints the job detector polls (see job.ts),
// but here they're called by the request handler, not the worker loop, so a
// broken worker can't hide from this check.
async function fetchFirmwareState(): Promise<HealthResult["firmware"]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FIRMWARE_POLL_TIMEOUT_MS);
  const base = config.INOVA_FIRMWARE_BASE_URL;
  try {
    const [psRes, fwRes] = await Promise.all([
      fetch(`${base}/api/printingservice/status`, { signal: controller.signal }),
      fetch(`${base}/api/status`, { signal: controller.signal }),
    ]);
    if (!psRes.ok || !fwRes.ok) {
      return {
        reachable: false,
        phase: null,
        is_printing: false,
        error: `firmware HTTP ${psRes.status}/${fwRes.status}`,
      };
    }
    const ps = (await psRes.json()) as { phase?: string | null };
    const fw = (await fwRes.json()) as { isPrinting?: boolean; isOnline?: boolean };
    return {
      reachable: fw.isOnline !== false,
      phase: ps.phase ?? null,
      is_printing: fw.isPrinting === true,
    };
  } catch (err) {
    return {
      reachable: false,
      phase: null,
      is_printing: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(t);
  }
}

function snapshotSpool(now: number): HealthResult["spool"] {
  const stats = getSpoolStats();
  const out = {} as HealthResult["spool"];
  for (const stream of SPOOL_STREAMS) {
    const s = stats[stream];
    out[stream] = {
      frame_lag_ms: s.lastFrameAt != null ? now - s.lastFrameAt : null,
      append_lag_ms: s.lastAppendAt != null ? now - s.lastAppendAt : null,
      lines: s.lines,
      last_error: s.lastError ? { at_ms: s.lastError.at, message: s.lastError.message } : null,
    };
  }
  return out;
}

function classify(
  firmware: HealthResult["firmware"],
  buildId: number | null,
  spool: HealthResult["spool"],
  now: number,
): { overall: RecordingState; reason: string } {
  if (now - SERVER_STARTED_AT < STARTUP_GRACE_MS) {
    return { overall: "STARTING_UP", reason: "server startup grace period" };
  }
  if (!firmware.reachable) {
    return {
      overall: "PRINTER_UNREACHABLE",
      reason: `plugin ${config.INOVA_API_BASE_URL} unreachable: ${firmware.error ?? "unknown"}`,
    };
  }
  if (firmware.is_printing) {
    if (buildId === null) {
      return {
        overall: "PRINTING_NOT_RECORDING",
        reason:
          "firmware reports printing but recorder has no current build_id — the job detector didn't see the build start",
      };
    }
    for (const stream of SPOOL_STREAMS) {
      const err = spool[stream].last_error;
      if (err && now - err.at_ms < SPOOL_ERROR_FRESH_MS) {
        return {
          overall: "PRINTING_NOT_RECORDING",
          reason: `spool write failing for ${stream}: ${err.message}`,
        };
      }
    }
    const lag = spool.telemetry.append_lag_ms;
    if (lag === null || lag > TELEMETRY_MAX_LAG_MS) {
      return {
        overall: "PRINTING_NOT_RECORDING",
        reason: `firmware reports printing but last telemetry spool append was ${lag == null ? "never" : `${lag}ms ago`} (budget ${TELEMETRY_MAX_LAG_MS}ms)`,
      };
    }
    return {
      overall: "RECORDING",
      reason: `phase=${firmware.phase}, telemetry append lag ${lag}ms, build_id=${buildId}`,
    };
  }
  return {
    overall: "IDLE",
    reason: firmware.phase ? `printer idle (phase=${firmware.phase})` : "printer idle",
  };
}

async function logTransition(
  prev: RecordingState | null,
  next: RecordingState,
  reason: string,
  detail: unknown,
): Promise<void> {
  if (isShuttingDown()) return;
  try {
    await pool.query(
      `INSERT INTO recording_health_events (prev_state, new_state, reason, detail)
       VALUES ($1, $2, $3, $4)`,
      [prev, next, reason, JSON.stringify(detail)],
    );
  } catch {
    // Logging must never take down the health endpoint.
  }
}

export async function evaluateHealth(): Promise<HealthResult> {
  const firmware = await fetchFirmwareState();
  const now = Date.now();
  const buildId = currentBuildId();
  const spool = snapshotSpool(now);
  const { overall, reason } = classify(firmware, buildId, spool, now);
  const result: HealthResult = {
    overall,
    reason,
    timestamp_ms: now,
    firmware,
    build: { current_build_id: buildId },
    spool,
    importer: getImporterStatus(),
    budgets: {
      telemetry_max_lag_ms: TELEMETRY_MAX_LAG_MS,
    },
  };
  if (overall !== lastState) {
    void logTransition(lastState, overall, reason, result);
    lastState = overall;
  }
  return result;
}

// Database connectivity + identity check. The identity part exists because
// of the 2026-07-09 docker/mount boot race: docker initdb'd a fresh cluster
// on the root fs and everything looked "connected" while the real database
// sat hidden under the mountpoint. Table presence + build count is the
// cheapest fingerprint that distinguishes the real cluster from a stale or
// freshly-initdb'd one (see wiki Operations gotchas).
export interface DbHealth {
  connected: boolean;
  latency_ms: number | null;
  error?: string;
  builds_count: number | null;
  max_build: number | null;
  last_event_ts: string | null;
  has_agent_tables: boolean | null;
  has_build_summaries: boolean | null;
}

async function evaluateDbHealth(): Promise<DbHealth> {
  const started = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM builds)  AS builds_count,
         (SELECT max(id)::int  FROM builds)  AS max_build,
         (SELECT max(ts)       FROM events)  AS last_event_ts,
         EXISTS (SELECT 1 FROM pg_tables
                 WHERE schemaname = 'public'
                   AND tablename = 'agent_conversations') AS has_agent_tables,
         EXISTS (SELECT 1 FROM pg_tables
                 WHERE schemaname = 'public'
                   AND tablename = 'build_summaries')     AS has_build_summaries`,
    );
    const r = rows[0];
    return {
      connected: true,
      latency_ms: Date.now() - started,
      builds_count: r.builds_count,
      max_build: r.max_build,
      last_event_ts: r.last_event_ts ? new Date(r.last_event_ts).toISOString() : null,
      has_agent_tables: r.has_agent_tables,
      has_build_summaries: r.has_build_summaries,
    };
  } catch (err) {
    return {
      connected: false,
      latency_ms: null,
      error: err instanceof Error ? err.message : String(err),
      builds_count: null,
      max_build: null,
      last_event_ts: null,
      has_agent_tables: null,
      has_build_summaries: null,
    };
  }
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health/recording", async () => evaluateHealth());
  app.get("/api/health/db", async () => evaluateDbHealth());
}
