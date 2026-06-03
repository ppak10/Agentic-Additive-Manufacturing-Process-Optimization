import type { FastifyBaseLogger } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId, isShuttingDown } from "./state.js";

type Kind = "chamber" | "thermal" | "galvo";

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
    get hz() { return config.CAMERA_HZ; },
    url: () => `${config.INOVA_FIRMWARE_BASE_URL}/api/plottedimage/${randomUUID()}`,
    ext: "png",
  },
];

async function captureOne(source: Source, buildId: number, log: FastifyBaseLogger): Promise<void> {
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
    await pool.query(
      `INSERT INTO frames (build_id, ts, kind, path) VALUES ($1, $2, $3, $4)`,
      [buildId, ts, source.kind, relPath],
    );
  } catch (err) {
    if (isShuttingDown()) return;
    log.warn({ err, kind: source.kind }, "frame capture failed");
  }
}

export function startCameraRecorder(log: FastifyBaseLogger): void {
  for (const source of SOURCES) {
    void (async () => {
      while (true) {
        const buildId = currentBuildId();
        if (buildId !== null) {
          await captureOne(source, buildId, log);
        }
        await new Promise((r) => setTimeout(r, 1000 / source.hz));
      }
    })();
  }
}
