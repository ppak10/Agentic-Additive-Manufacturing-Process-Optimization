import { createReadStream } from "node:fs";
import { readdir, rename, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import type { StateSnapshot, Timed } from "@inova/client";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId } from "./state.js";
import {
  closeBuildSpools,
  spoolFilePath,
  SPOOL_STREAMS,
  type SpoolStream,
} from "./spool.js";
import { expand } from "./telemetry.js";
import type { PositionFrame } from "./positionStream.js";
import type { FrameSpoolLine } from "./camera.js";

// Post-print importer: replays the NVMe spool (see spool.ts) into Postgres.
// Runs after a build closes, when realtime no longer matters — the SMR disk
// under the DB handles bulk sequential INSERTs fine, it just can't take them
// at print time. Row timestamps come from the frame payloads, so imported
// rows are indistinguishable from rows that were inserted live.
//
// Idempotency: each imported file gets a marker row in `events`
// (kind='spool_imported', message='<stream>.ndjson') written in the SAME
// transaction as its rows, and the file is renamed to *.imported only after
// COMMIT. A crash mid-import rolls back cleanly and the next run redoes the
// file; a crash between COMMIT and rename is caught by the marker check.

const BATCH_ROWS = 2000;

// Startup recovery won't touch a spool whose build is still open in the DB
// and whose files were written to recently — that's an in-flight print the
// job detector is about to re-adopt.
const RECOVERY_MIN_IDLE_MS = 10 * 60_000;

interface StreamSpec {
  table: string;
  columns: string[];
  // One NDJSON line → zero or more value tuples (telemetry expands ~28:1).
  mapLine(line: string, buildId: number): unknown[][];
}

const SPECS: Record<SpoolStream, StreamSpec> = {
  telemetry: {
    table: "telemetry",
    columns: ["build_id", "ts", "sensor_id", "kind", "value"],
    mapLine: (line, buildId) =>
      expand(JSON.parse(line) as Timed<StateSnapshot>, buildId).map((r) => [
        r.buildId,
        r.ts,
        r.sensorId,
        r.kind,
        r.value,
      ]),
  },
  position: {
    table: "position_hf",
    columns: ["build_id", "ts", "x", "y", "z1", "z2", "r", "has_homed"],
    mapLine: (line, buildId) => {
      const f = JSON.parse(line) as PositionFrame;
      return [
        [buildId, new Date(f.respondedAt), f.data.x, f.data.y, f.data.z1, f.data.z2, f.data.r, f.data.hasHomed],
      ];
    },
  },
  frames: {
    table: "frames",
    columns: ["build_id", "ts", "kind", "path"],
    mapLine: (line, buildId) => {
      const f = JSON.parse(line) as FrameSpoolLine;
      return [[buildId, new Date(f.respondedAt), f.kind, f.path]];
    },
  },
};

export interface ImporterStatus {
  buildId: number;
  stream: SpoolStream;
  rowsInserted: number;
}

let status: ImporterStatus | null = null;
export function getImporterStatus(): ImporterStatus | null {
  return status;
}

// Imports run strictly one at a time — back-to-back prints enqueue behind
// each other rather than competing for the disk.
let queue: Promise<void> = Promise.resolve();
let queueDepth = 0;

// Number of imports queued or running — 0 means the spool → Postgres path
// is drained (safe to exit for stop-after-build).
export function importQueueDepth(): number {
  return queueDepth;
}

export function enqueueImport(buildId: number, log: FastifyBaseLogger): void {
  queueDepth += 1;
  queue = queue
    .then(() => importBuildSpools(buildId, log))
    .catch((err) => log.error({ err, buildId }, "spool import failed"))
    .finally(() => {
      queueDepth -= 1;
    });
}

async function insertBatch(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const n = columns.length;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    placeholders.push(`(${row.map((_, j) => `$${i * n + j + 1}`).join(",")})`);
    values.push(...row);
  }
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(",")}`,
    values,
  );
}

async function alreadyImported(buildId: number, filename: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM events WHERE build_id = $1 AND kind = 'spool_imported' AND message = $2 LIMIT 1`,
    [buildId, filename],
  );
  return rows.length > 0;
}

async function importOneFile(
  buildId: number,
  stream: SpoolStream,
  log: FastifyBaseLogger,
): Promise<void> {
  const path = spoolFilePath(buildId, stream);
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    return; // stream never produced a file for this build
  }
  const filename = `${stream}.ndjson`;
  if (await alreadyImported(buildId, filename)) {
    log.warn({ buildId, stream }, "spool file already imported, skipping (leftover rename?)");
    return;
  }

  const spec = SPECS[stream];
  const client = await pool.connect();
  let inserted = 0;
  let badLines = 0;
  status = { buildId, stream, rowsInserted: 0 };
  try {
    await client.query("BEGIN");
    let batch: unknown[][] = [];
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let rows: unknown[][];
      try {
        rows = spec.mapLine(line, buildId);
      } catch {
        // Almost always the trailing partial line from a crash mid-append.
        badLines++;
        continue;
      }
      batch.push(...rows);
      if (batch.length >= BATCH_ROWS) {
        await insertBatch(client, spec.table, spec.columns, batch);
        inserted += batch.length;
        status.rowsInserted = inserted;
        batch = [];
      }
    }
    await insertBatch(client, spec.table, spec.columns, batch);
    inserted += batch.length;
    await client.query(
      `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, 'spool_imported', $2, $3)`,
      [buildId, filename, JSON.stringify({ rows: inserted, badLines, bytes: fileStat.size })],
    );
    await client.query("COMMIT");
    await rename(path, `${path}.imported`);
    log.info({ buildId, stream, rows: inserted, badLines, bytes: fileStat.size }, "spool file imported");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    status = null;
  }
}

export async function importBuildSpools(buildId: number, log: FastifyBaseLogger): Promise<void> {
  await closeBuildSpools(buildId); // flush writer buffers before reading
  for (const stream of SPOOL_STREAMS) {
    await importOneFile(buildId, stream, log);
  }
}

// Startup recovery: pick up spools left behind by a crash or restart. Skips
// the currently-recording build; skips builds that are still open in the DB
// with recently-touched spool files (the detector may be about to re-adopt
// them). Call this AFTER the job detector has had time to adopt an
// in-progress build, or a mid-print restart would import — and then stop
// appending to — the active build's spool.
export async function recoverPendingSpools(log: FastifyBaseLogger): Promise<void> {
  let entries;
  try {
    entries = await readdir(config.SPOOL_DIR, { withFileTypes: true });
  } catch {
    return; // no spool dir yet — nothing to recover
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const buildId = Number(entry.name);
    if (buildId === currentBuildId()) continue;

    let newestMtime = 0;
    let hasPending = false;
    for (const stream of SPOOL_STREAMS) {
      try {
        const s = await stat(spoolFilePath(buildId, stream));
        hasPending = true;
        newestMtime = Math.max(newestMtime, s.mtimeMs);
      } catch {
        /* stream has no pending file */
      }
    }
    if (!hasPending) continue;

    const { rows } = await pool.query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM builds WHERE id = $1`,
      [buildId],
    );
    const stillOpen = rows.length > 0 && rows[0]!.ended_at === null;
    if (stillOpen && Date.now() - newestMtime < RECOVERY_MIN_IDLE_MS) {
      log.info({ buildId }, "spool recovery: build still open and recently active, skipping");
      continue;
    }
    log.info({ buildId }, "spool recovery: importing leftover spool");
    enqueueImport(buildId, log);
  }
}
