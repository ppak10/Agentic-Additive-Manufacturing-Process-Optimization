import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

// Append-only NDJSON spool on the NVMe. During a print the high-rate streams
// (telemetry, position, plotter commands, frame metadata) are appended here
// instead of INSERTed into Postgres — the DB lives on a 5400rpm SMR disk that
// cannot absorb fsync-heavy random writes while autovacuum runs, which is what
// caused the RECORDING/NOT RECORDING flapping. After the build closes, the
// importer replays these files into Postgres (see importer.ts); every row's
// timestamp comes from the frame payload, so late loading produces rows
// identical to live recording.
//
// One file per (build, stream): SPOOL_DIR/<buildId>/<stream>.ndjson. Lines are
// the raw upstream frames verbatim so the importer can reuse the recorders'
// own row-mapping code. A crash loses at most the last partial line (the
// importer skips lines that fail to parse).

export type SpoolStream = "telemetry" | "position" | "plotter" | "frames";

export const SPOOL_STREAMS: readonly SpoolStream[] = [
  "telemetry",
  "position",
  "plotter",
  "frames",
];

export interface SpoolStreamStats {
  // Last frame received from upstream, regardless of build state. Measures
  // "is the pipe from the plugin alive".
  lastFrameAt: number | null;
  // Last line handed to the spool writer (only advances during a build).
  // Measures "is the recording actually being captured".
  lastAppendAt: number | null;
  lines: number;
  lastError: { at: number; message: string } | null;
}

const stats: Record<SpoolStream, SpoolStreamStats> = {
  telemetry: { lastFrameAt: null, lastAppendAt: null, lines: 0, lastError: null },
  position: { lastFrameAt: null, lastAppendAt: null, lines: 0, lastError: null },
  plotter: { lastFrameAt: null, lastAppendAt: null, lines: 0, lastError: null },
  frames: { lastFrameAt: null, lastAppendAt: null, lines: 0, lastError: null },
};

const writers = new Map<string, WriteStream>();

export function spoolBuildDir(buildId: number): string {
  return resolve(config.SPOOL_DIR, String(buildId));
}

export function spoolFilePath(buildId: number, stream: SpoolStream): string {
  return resolve(spoolBuildDir(buildId), `${stream}.ndjson`);
}

function writerFor(buildId: number, stream: SpoolStream): WriteStream {
  const key = `${buildId}:${stream}`;
  let ws = writers.get(key);
  if (ws) return ws;
  mkdirSync(spoolBuildDir(buildId), { recursive: true });
  ws = createWriteStream(spoolFilePath(buildId, stream), { flags: "a" });
  ws.on("error", (err) => {
    stats[stream].lastError = { at: Date.now(), message: err.message };
    // Drop the broken writer; the next append re-opens the file. If the disk
    // is genuinely unwritable the error re-surfaces (and health reports it).
    writers.delete(key);
  });
  writers.set(key, ws);
  return ws;
}

// Record that a frame arrived from upstream (called for every frame, even
// when no build is active and nothing is appended).
export function noteFrame(stream: SpoolStream): void {
  stats[stream].lastFrameAt = Date.now();
}

export function appendSpool(stream: SpoolStream, buildId: number, line: string): void {
  writerFor(buildId, stream).write(line + "\n");
  const s = stats[stream];
  s.lastAppendAt = Date.now();
  s.lines++;
}

export function getSpoolStats(): Record<SpoolStream, SpoolStreamStats> {
  return stats;
}

function endWriter(key: string, ws: WriteStream): Promise<void> {
  return new Promise((done) => {
    ws.end(() => done());
    writers.delete(key);
  });
}

// Flush and close all writers for one build (before importing it).
export async function closeBuildSpools(buildId: number): Promise<void> {
  const prefix = `${buildId}:`;
  const pending: Promise<void>[] = [];
  for (const [key, ws] of writers) {
    if (key.startsWith(prefix)) pending.push(endWriter(key, ws));
  }
  await Promise.all(pending);
}

// Flush everything on shutdown so buffered lines reach the disk.
export async function closeAllSpools(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [key, ws] of writers) pending.push(endWriter(key, ws));
  await Promise.all(pending);
}
