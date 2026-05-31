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

let latestStatus: PrintingStatus | null = null;
export function getLatestPrintingStatus(): PrintingStatus | null {
  return latestStatus;
}

async function fetchStatus(): Promise<PrintingStatus | null> {
  try {
    const r = await fetch(`${config.INOVA_FIRMWARE_BASE_URL}/api/printingservice/status`);
    if (!r.ok) return null;
    return (await r.json()) as PrintingStatus;
  } catch {
    return null;
  }
}

function isActive(s: PrintingStatus): boolean {
  return s.phase !== null || s.jobName !== null;
}

async function openBuild(s: PrintingStatus, log: FastifyBaseLogger, joinedMidBuild = false): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO builds (job_name, phase, params, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      s.jobName,
      s.phase,
      { printProfileName: s.printProfileName, surfaceTarget: s.surfaceTarget },
      joinedMidBuild ? "server joined mid-build" : null,
    ],
  );
  const id = rows[0]!.id;
  await pool.query(
    `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, $2, $3, $4)`,
    [id, "build_start", s.jobName ?? "(unnamed)", s as unknown as Record<string, unknown>],
  );
  log.info({ buildId: id, jobName: s.jobName, phase: s.phase, joinedMidBuild }, "build opened");
  return id;
}

async function closeBuild(id: number, log: FastifyBaseLogger): Promise<void> {
  await pool.query(`UPDATE builds SET ended_at = now() WHERE id = $1`, [id]);
  await pool.query(`INSERT INTO events (build_id, kind, message) VALUES ($1, $2, $3)`, [id, "build_end", null]);
  log.info({ buildId: id }, "build closed");
}

export function startJobDetector(log: FastifyBaseLogger): void {
  let currentId: number | null = null;

  void (async () => {
    while (true) {
      const s = await fetchStatus();
      if (s) {
        latestStatus = s;
        const active = isActive(s);
        if (active && currentId === null) {
          currentId = await openBuild(s, log, true);
          setCurrentBuildId(currentId);
        } else if (!active && currentId !== null) {
          await closeBuild(currentId, log);
          setCurrentBuildId(null);
          currentId = null;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}
