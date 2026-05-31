import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { setCurrentBuildId } from "./state.js";

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

  void (async () => {
    while (true) {
      const [ps, fw] = await Promise.all([
        fetchJson<PrintingStatus>("/api/printingservice/status"),
        fetchJson<FirmwareStatus>("/api/status"),
      ]);

      if (ps) {
        latestStatus = ps;
        const active = isActive(ps, fw);

        if (active && currentId === null) {
          currentId = await openBuild(ps, fw, log, true);
          setCurrentBuildId(currentId);
          prevPs = ps;
        } else if (!active && currentId !== null) {
          await closeBuild(currentId, prevPs, log);
          setCurrentBuildId(null);
          currentId = null;
          prevPs = null;
        } else if (active && currentId !== null && prevPs !== null) {
          if (ps.phase !== prevPs.phase || ps.jobName !== prevPs.jobName) {
            await recordPhaseChange(currentId, prevPs, ps, log);
          }
          prevPs = ps;
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  })();
}
