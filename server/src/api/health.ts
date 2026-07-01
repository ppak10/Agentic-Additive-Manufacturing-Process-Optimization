import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId } from "../recorder/state.js";
import { isShuttingDown } from "../recorder/state.js";

// Lag budgets. Telemetry is polled at 10 Hz → we expect a fresh row every 100 ms;
// 3 s is 30× the interval, generous enough to smooth over one dropped poll cycle
// without hiding a real recorder failure. Frames vary by kind (chamber 5 Hz,
// thermal 2 Hz, galvo variable) — 10 s covers the slowest kind.
const TELEMETRY_MAX_LAG_MS = 3_000;
const FRAMES_MAX_LAG_MS = 10_000;
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
  db: {
    current_build_id: number | null;
    telemetry_last_ts_ms: number | null;
    telemetry_lag_ms: number | null;
    frames_last_ts_ms: number | null;
    frames_lag_ms: number | null;
    position_hf_last_ts_ms: number | null;
    position_hf_lag_ms: number | null;
  };
  budgets: {
    telemetry_max_lag_ms: number;
    frames_max_lag_ms: number;
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

async function fetchDbLags(buildId: number | null): Promise<Omit<HealthResult["db"], "current_build_id">> {
  const empty = {
    telemetry_last_ts_ms: null,
    telemetry_lag_ms: null,
    frames_last_ts_ms: null,
    frames_lag_ms: null,
    position_hf_last_ts_ms: null,
    position_hf_lag_ms: null,
  };
  if (buildId === null) return empty;
  if (isShuttingDown()) return empty;
  // Each MAX(ts) uses the (build_id, ts DESC) index — index-only scan, cheap
  // regardless of table size. Bundled into one round-trip.
  const { rows } = await pool.query<{
    telemetry_last: Date | null;
    frames_last: Date | null;
    position_hf_last: Date | null;
  }>(
    `SELECT
       (SELECT MAX(ts) FROM telemetry WHERE build_id = $1)   AS telemetry_last,
       (SELECT MAX(ts) FROM frames WHERE build_id = $1)      AS frames_last,
       (SELECT MAX(ts) FROM position_hf WHERE build_id = $1) AS position_hf_last`,
    [buildId],
  );
  const r = rows[0];
  const now = Date.now();
  const asMs = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);
  const telemetry_last_ts_ms = asMs(r?.telemetry_last);
  const frames_last_ts_ms = asMs(r?.frames_last);
  const position_hf_last_ts_ms = asMs(r?.position_hf_last);
  return {
    telemetry_last_ts_ms,
    telemetry_lag_ms: telemetry_last_ts_ms != null ? now - telemetry_last_ts_ms : null,
    frames_last_ts_ms,
    frames_lag_ms: frames_last_ts_ms != null ? now - frames_last_ts_ms : null,
    position_hf_last_ts_ms,
    position_hf_lag_ms: position_hf_last_ts_ms != null ? now - position_hf_last_ts_ms : null,
  };
}

function classify(
  firmware: HealthResult["firmware"],
  db: HealthResult["db"],
): { overall: RecordingState; reason: string } {
  if (Date.now() - SERVER_STARTED_AT < STARTUP_GRACE_MS) {
    return { overall: "STARTING_UP", reason: "server startup grace period" };
  }
  if (!firmware.reachable) {
    return {
      overall: "PRINTER_UNREACHABLE",
      reason: `plugin ${config.INOVA_API_BASE_URL} unreachable: ${firmware.error ?? "unknown"}`,
    };
  }
  if (firmware.is_printing) {
    if (db.current_build_id === null) {
      return {
        overall: "PRINTING_NOT_RECORDING",
        reason:
          "firmware reports printing but recorder has no current build_id — the job detector didn't see the build start",
      };
    }
    if (db.telemetry_lag_ms === null || db.telemetry_lag_ms > TELEMETRY_MAX_LAG_MS) {
      const lag = db.telemetry_lag_ms == null ? "no rows for this build" : `${db.telemetry_lag_ms}ms`;
      return {
        overall: "PRINTING_NOT_RECORDING",
        reason: `firmware reports printing but telemetry lag = ${lag} (budget ${TELEMETRY_MAX_LAG_MS}ms)`,
      };
    }
    return {
      overall: "RECORDING",
      reason: `phase=${firmware.phase}, telemetry lag ${db.telemetry_lag_ms}ms, build_id=${db.current_build_id}`,
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
  const [firmware, buildId] = [await fetchFirmwareState(), currentBuildId()];
  const dbLags = await fetchDbLags(buildId);
  const db: HealthResult["db"] = { current_build_id: buildId, ...dbLags };
  const { overall, reason } = classify(firmware, db);
  const result: HealthResult = {
    overall,
    reason,
    timestamp_ms: Date.now(),
    firmware,
    db,
    budgets: {
      telemetry_max_lag_ms: TELEMETRY_MAX_LAG_MS,
      frames_max_lag_ms: FRAMES_MAX_LAG_MS,
    },
  };
  if (overall !== lastState) {
    void logTransition(lastState, overall, reason, result);
    lastState = overall;
  }
  return result;
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health/recording", async () => evaluateHealth());
}
