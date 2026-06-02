import { InovaClient, type StateSnapshot, type Timed } from "@inova/client";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId } from "./state.js";

type Row = {
  buildId: number | null;
  ts: Date;
  sensorId: string;
  kind: string;
  value: number;
};

const BATCH_SIZE = 100;
const BATCH_MS = 200;

let buffer: Row[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function expand(frame: Timed<StateSnapshot>): Row[] {
  const ts = new Date(frame.respondedAt);
  const buildId = currentBuildId();
  const rows: Row[] = [];
  const s = frame.data;

  for (const k of ["x", "y", "z1", "z2", "r"] as const) {
    rows.push({ buildId, ts, sensorId: "positions", kind: `position.${k}`, value: s.position[k] });
  }

  rows.push({ buildId, ts, sensorId: "lights", kind: "lights.enabled", value: s.lights.isEnabled ? 1 : 0 });
  rows.push({ buildId, ts, sensorId: "lights", kind: "lights.count", value: s.lights.lightCount });

  for (const e of s.power.entries) {
    rows.push({ buildId, ts, sensorId: e.id, kind: "power", value: e.power });
  }
  rows.push({ buildId, ts, sensorId: "powerman", kind: "power.current", value: s.power.powerman.currentPower });
  rows.push({ buildId, ts, sensorId: "powerman", kind: "power.required", value: s.power.powerman.requiredPower });
  rows.push({ buildId, ts, sensorId: "powerman", kind: "power.max", value: s.power.powerman.maxPower });

  for (const e of s.temperature.entries) {
    rows.push({ buildId, ts, sensorId: e.id, kind: "temp.current", value: e.currentTemperature });
    rows.push({ buildId, ts, sensorId: e.id, kind: "temp.average", value: e.averageTemperature });
    if (e.targetTemperature !== null) {
      rows.push({ buildId, ts, sensorId: e.id, kind: "temp.target", value: e.targetTemperature });
    }
  }

  return rows;
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const o = i * 5;
    placeholders.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5})`);
    values.push(r.buildId, r.ts, r.sensorId, r.kind, r.value);
  }
  await pool.query(
    `INSERT INTO telemetry (build_id, ts, sensor_id, kind, value) VALUES ${placeholders.join(",")}`,
    values,
  );
}

function scheduleFlush(log: FastifyBaseLogger): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flush().catch((err) => log.error({ err }, "telemetry flush failed"));
  }, BATCH_MS);
}

let latestSnapshot: Timed<StateSnapshot> | null = null;
export function getLatestSnapshot(): Timed<StateSnapshot> | null {
  return latestSnapshot;
}

export function startTelemetryRecorder(log: FastifyBaseLogger): void {
  const client = new InovaClient(config.INOVA_API_BASE_URL);

  void (async () => {
    let backoff = 1000;
    while (true) {
      try {
        log.info(`telemetry: connecting to ${config.INOVA_API_BASE_URL}/state/stream @ ${config.TELEMETRY_HZ}Hz`);
        for await (const frame of client.streamState(config.TELEMETRY_HZ)) {
          latestSnapshot = frame;
          if (currentBuildId() !== null) {
            buffer.push(...expand(frame));
            if (buffer.length >= BATCH_SIZE) {
              await flush();
            } else {
              scheduleFlush(log);
            }
          }
          backoff = 1000;
        }
        log.warn("telemetry stream closed cleanly, reconnecting");
      } catch (err) {
        log.error({ err }, "telemetry stream error, reconnecting");
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  })();
}
