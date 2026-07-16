import { InovaClient, type StateSnapshot, type Timed } from "@inova/client";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { currentBuildId, isShuttingDown } from "./state.js";
import { appendSpool, noteFrame } from "./spool.js";

export type TelemetryRow = {
  buildId: number;
  ts: Date;
  sensorId: string;
  kind: string;
  value: number;
};

// Flattens one state frame into telemetry rows. Shared with the importer —
// spooled frames replayed through this function produce rows identical to
// what live recording used to insert.
export function expand(frame: Timed<StateSnapshot>, buildId: number): TelemetryRow[] {
  const ts = new Date(frame.respondedAt);
  const rows: TelemetryRow[] = [];
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
          noteFrame("telemetry");
          const buildId = currentBuildId();
          // Spool the frame verbatim — no DB on the print-time path. The
          // importer expands it into telemetry rows after the build ends.
          if (buildId !== null && !isShuttingDown()) {
            appendSpool("telemetry", buildId, JSON.stringify(frame));
          }
          backoff = 1000;
        }
        log.warn("telemetry stream closed cleanly, reconnecting");
      } catch (err) {
        log.error({ msg: (err as Error)?.message ?? String(err) }, "telemetry stream error, reconnecting");
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  })();
}
