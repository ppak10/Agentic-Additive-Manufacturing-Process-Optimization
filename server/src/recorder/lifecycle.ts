// Recorder lifecycle: orphan-build reconciliation and stop-after-build.
//
// Together with the unreachable-printer finalization in job.ts, these close
// the "recorder needs a human to notice" gaps: builds left open by crashes
// or power loss get finalized at the next startup, and maintenance can ask
// the recorder to bow out cleanly once the current build is done instead of
// being killed by PID.
import type { FastifyBaseLogger } from "fastify";
import { pool } from "../db/pool.js";
import { currentBuildId } from "./state.js";
import { importQueueDepth } from "./importer.js";

// Close any build that is still open but isn't the one we're recording and
// isn't the job currently printing (the detector may be about to adopt
// that one). ended_at = the last timestamp the build actually produced
// (telemetry or frames), falling back to started_at for data-less stubs.
export async function reconcileOrphanBuilds(
  log: FastifyBaseLogger,
  activeJobName: string | null,
): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM builds
     WHERE ended_at IS NULL
       AND id <> coalesce($1, -1)
       AND ($2::text IS NULL OR job_name IS DISTINCT FROM $2)
     ORDER BY id`,
    [currentBuildId(), activeJobName],
  );
  for (const { id } of rows) {
    await pool.query(
      `UPDATE builds SET
         ended_at = coalesce(
           greatest(
             (SELECT max(ts) FROM telemetry t WHERE t.build_id = builds.id),
             (SELECT max(ts) FROM frames f WHERE f.build_id = builds.id)),
           started_at),
         notes = coalesce(notes || ' ', '') || '[finalized by startup reconciliation]'
       WHERE id = $1 AND ended_at IS NULL`,
      [id],
    );
    await pool.query(
      `INSERT INTO events (build_id, kind, message)
       VALUES ($1, 'build_finalized', 'startup reconciliation: build was left open')`,
      [id],
    );
    log.info({ buildId: id }, "reconciliation: finalized orphan open build");
  }
  if (rows.length > 0) {
    log.info({ count: rows.length }, "reconciliation: orphan builds closed");
  }
}

// ---------------------------------------------------------------------------
// Stop-after-build: a maintenance flag. When set, the recorder exits cleanly
// (SIGTERM to itself → existing shutdown path → exit 0, which both
// run-recorder.sh and the systemd unit treat as "stay stopped") as soon as
// no build is being recorded and the spool import queue is drained.

let stopRequested = false;
let exiting = false;

export function requestStopAfterBuild(): void {
  stopRequested = true;
}

export function cancelStopAfterBuild(): boolean {
  const was = stopRequested;
  stopRequested = false;
  return was;
}

export function stopAfterBuildStatus(): {
  requested: boolean;
  currentBuildId: number | null;
  importQueueDepth: number;
} {
  return {
    requested: stopRequested,
    currentBuildId: currentBuildId(),
    importQueueDepth: importQueueDepth(),
  };
}

// Called by the job detector whenever it is idle (no active build). Waits
// for the import queue to drain, then stops the process.
export function maybeStopAfterBuild(log: FastifyBaseLogger): void {
  if (!stopRequested || exiting) return;
  if (currentBuildId() !== null) return;
  if (importQueueDepth() > 0) return; // detector will call again next poll
  exiting = true;
  log.info("stop-after-build: idle and import queue drained — stopping");
  process.kill(process.pid, "SIGTERM");
}
