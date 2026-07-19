import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InovaClient } from "../client.js";
import { errorResult, jsonResult } from "../result.js";

interface SnapshotData {
  position?: Record<string, number>;
  lights?: { isEnabled?: boolean; lightCount?: number };
  power?: { entries?: Array<{ id: string; power: number }> };
  temperature?: {
    entries?: Array<{
      id: string;
      currentTemperature?: number;
      targetTemperature?: number;
    }>;
  };
}

interface PlotterInfo {
  layerCount: number;
  currentLayer: number;
  currentCmdIdx: number;
  isEmpty: boolean;
  buildEpoch: string;
}

// The print phase (Heating/BedPreparation/Printing/Cooling), job identity,
// and recording state come from the RECORDER (:3000), which already
// consumes the firmware's rich status — the plugin on :5001 deliberately
// doesn't proxy it. Read-only; degrade gracefully when the recorder is
// down so the plugin-side snapshot still answers.
const RECORDER_BASE_URL =
  process.env.RECORDER_BASE_URL ?? "http://localhost:3000";

async function fetchRecorder<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${RECORDER_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface JobCurrent {
  phase: string | null;
  jobName: string | null;
  printProfileName: string | null;
  progress: number;
  remaining: string;
  remainingIncomplete: boolean;
  phaseDone: number | null;
  phaseTotal: number | null;
  surfaceTarget: number | null;
}

interface RecordingHealth {
  overall: string;
  firmware?: { is_printing?: boolean };
  build?: { current_build_id?: number | null };
}

// Compact the verbose firmware snapshot into something an agent can afford to
// read every turn: id→value maps instead of timestamped entry arrays.
function compactSnapshot(data: SnapshotData) {
  return {
    position: data.position,
    lights: data.lights,
    power: Object.fromEntries(
      (data.power?.entries ?? []).map((e) => [e.id, e.power]),
    ),
    temperatures: Object.fromEntries(
      (data.temperature?.entries ?? []).map((e) => [
        e.id,
        { current: e.currentTemperature, target: e.targetTemperature },
      ]),
    ),
  };
}

export function registerPrinterStatus(server: McpServer, client: InovaClient) {
  server.registerTool(
    "printer_status",
    {
      title: "Printer status",
      description:
        "Read-only snapshot of the SLS printer: whether it is printing, the current job " +
        "(name, print profile, phase — Heating/BedPreparation/Printing/Cooling — and " +
        "progress), which build is being recorded, current layer / layer count / build " +
        "epoch (from the plotter), axis positions, per-zone temperatures (current + " +
        "target, °C), power states (laser, heaters, fans), and the active recoater " +
        "override state (staged passes + full-recoat passes). Call this before changing " +
        "any override to understand where the build is.",
      inputSchema: {},
    },
    async () => {
      try {
        const [plotter, snapshot, staged, full, job, health] = await Promise.all([
          client.get<PlotterInfo>("/plotter/info"),
          client.get<SnapshotData>("/state/snapshot"),
          client.get<unknown>("/printing/recoater-passes"),
          client.get<unknown>("/printing/recoater-passes-full"),
          fetchRecorder<JobCurrent>("/api/job/current"),
          fetchRecorder<RecordingHealth>("/api/health/recording"),
        ]);
        return jsonResult({
          respondedAt: snapshot.respondedAt,
          is_printing: health?.firmware?.is_printing ?? null,
          job: job
            ? {
                name: job.jobName,
                printProfileName: job.printProfileName,
                phase: job.phase,
                phaseDone: job.phaseDone,
                phaseTotal: job.phaseTotal,
                progress: job.progress,
                remaining: job.remaining,
                remainingIncomplete: job.remainingIncomplete,
                surfaceTarget: job.surfaceTarget,
              }
            : "(recorder unreachable — job/phase unknown)",
          recording: health
            ? { overall: health.overall, build_id: health.build?.current_build_id ?? null }
            : "(recorder unreachable)",
          plotter: plotter.data,
          ...compactSnapshot(snapshot.data),
          recoater: { staged: staged.data, full: full.data },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
