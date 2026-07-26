import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { setCurrentBuildId, isShuttingDown, setFramesRecording } from "./state.js";

// The one firmware phase during which frames + position are worth spooling.
const PRINTING_PHASE = "Layers";
import { enqueueImport } from "./importer.js";
import { maybeStopAfterBuild } from "./lifecycle.js";

interface PrintingStatus {
  phase: string | null;
  jobName: string | null;
  progress: number;
  phaseDone: number | null;
  phaseTotal: number | null;
  printProfileName: string | null;
  surfaceTarget: number | null;
  remaining: string;
}

interface FirmwareStatus {
  name: string;
  hostName: string;
  isOnline: boolean;
  isPrinting: boolean;
  hasInfoMessages: boolean;
  hasWarningMessages: boolean;
  hasErrorMessages: boolean;
}

let latestStatus: PrintingStatus | null = null;
export function getLatestPrintingStatus(): PrintingStatus | null {
  return latestStatus;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${config.INOVA_FIRMWARE_BASE_URL}${path}`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function isActive(s: PrintingStatus, firmware: FirmwareStatus | null): boolean {
  if (firmware?.isPrinting) return true;
  return s.phase !== null || s.jobName !== null;
}

// Adopt an existing in-progress build for the current jobName if one exists,
// otherwise open a new one. Fixes the orphaned-builds bug where every server
// restart used to create a duplicate row for the same physical job. Also
// closes any older orphans for the same job so the table stays tidy.
async function findOrOpenBuild(
  ps: PrintingStatus,
  fw: FirmwareStatus | null,
  log: FastifyBaseLogger,
): Promise<number> {
  if (ps.jobName) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM builds
       WHERE job_name = $1 AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [ps.jobName],
    );
    if (rows.length > 0) {
      const id = rows[0]!.id;
      log.info({ buildId: id, jobName: ps.jobName }, "adopting in-progress build");
      await pool.query(
        `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, $2, $3, $4)`,
        [id, "build_resumed", `server reattached to ${ps.jobName}`, ps as unknown as Record<string, unknown>],
      );
      // Sweep any older orphans for this job into ended state so they stop
      // polluting build lists and replay menus.
      await pool.query(
        `UPDATE builds SET ended_at = now(),
           notes = COALESCE(notes || ' ', '') || '[closed at restart, replaced by build #' || $2 || ']'
         WHERE job_name = $1 AND ended_at IS NULL AND id < $2`,
        [ps.jobName, id],
      );
      return id;
    }
  }
  return await openBuild(ps, fw, log, true);
}

async function openBuild(
  ps: PrintingStatus,
  fw: FirmwareStatus | null,
  log: FastifyBaseLogger,
  joinedMidBuild: boolean,
): Promise<number> {
  const params = {
    printingService: ps,
    firmware: fw,
    printProfileName: ps.printProfileName,
    surfaceTarget: ps.surfaceTarget,
    phaseTotal: ps.phaseTotal,
  };
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO builds (job_name, phase, params, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ps.jobName, ps.phase, params, joinedMidBuild ? "server joined mid-build" : null],
  );
  const id = rows[0]!.id;
  await pool.query(
    `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, $2, $3, $4)`,
    [id, "build_start", ps.jobName ?? "(unnamed)", params],
  );
  log.info({ buildId: id, jobName: ps.jobName, phase: ps.phase, joinedMidBuild }, "build opened");
  return id;
}

async function closeBuild(id: number, lastPs: PrintingStatus | null, log: FastifyBaseLogger): Promise<void> {
  await pool.query(`UPDATE builds SET ended_at = now() WHERE id = $1`, [id]);
  await pool.query(
    `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, $2, $3, $4)`,
    [id, "build_end", null, lastPs],
  );
  log.info({ buildId: id }, "build closed");
}

async function recordPhaseChange(
  id: number,
  prev: PrintingStatus,
  next: PrintingStatus,
  log: FastifyBaseLogger,
): Promise<void> {
  await pool.query(
    `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, $2, $3, $4)`,
    [id, "phase_change", `${prev.phase ?? "(idle)"} → ${next.phase ?? "(idle)"}`, next],
  );
  log.info({ buildId: id, from: prev.phase, to: next.phase }, "phase changed");
}

export function startJobDetector(log: FastifyBaseLogger): void {
  let currentId: number | null = null;
  let prevPs: PrintingStatus | null = null;
  // First moment the firmware became continuously unreachable while a
  // build was open; null while reachable.
  let unreachableSince: number | null = null;

  void (async () => {
    while (true) {
      const [ps, fw] = await Promise.all([
        fetchJson<PrintingStatus>("/api/printingservice/status"),
        fetchJson<FirmwareStatus>("/api/status"),
      ]);

      if (ps) {
        unreachableSince = null;
        latestStatus = ps;
        const active = isActive(ps, fw);

        if (active && currentId === null) {
          if (isShuttingDown()) continue;
          currentId = await findOrOpenBuild(ps, fw, log);
          setCurrentBuildId(currentId);
          prevPs = ps;
        } else if (!active && currentId !== null) {
          if (isShuttingDown()) continue;
          await closeBuild(currentId, prevPs, log);
          setCurrentBuildId(null);
          // Print is over — realtime no longer matters, so drain the NVMe
          // spool into Postgres now. Queued: never blocks the detector loop.
          enqueueImport(currentId, log);
          currentId = null;
          prevPs = null;
        } else if (active && currentId !== null && prevPs !== null) {
          if (ps.phase !== prevPs.phase || ps.jobName !== prevPs.jobName) {
            await recordPhaseChange(currentId, prevPs, ps, log);
          }
          prevPs = ps;
        }
      } else if (currentId !== null && !isShuttingDown()) {
        // Firmware unreachable with a build open (printer powered off
        // mid-build, network gone). After a continuous grace period,
        // finalize the build ourselves — otherwise it stays open forever
        // and its spool never imports.
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= config.UNREACHABLE_FINALIZE_MS) {
          const minutes = Math.round((Date.now() - unreachableSince) / 60_000);
          log.warn(
            { buildId: currentId, minutes },
            "firmware unreachable — finalizing open build",
          );
          await pool.query(
            `UPDATE builds SET
               notes = coalesce(notes || ' ', '') || '[finalized: printer unreachable]'
             WHERE id = $1`,
            [currentId],
          );
          await closeBuild(currentId, prevPs, log);
          setCurrentBuildId(null);
          enqueueImport(currentId, log);
          currentId = null;
          prevPs = null;
          unreachableSince = null;
        }
      }

      // Gate the heavy frame/position spool on the printing phase. False the
      // instant the firmware goes unreachable (ps null) or leaves "Layers".
      setFramesRecording(currentId !== null && ps?.phase === PRINTING_PHASE);

      if (currentId === null) maybeStopAfterBuild(log);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
}
