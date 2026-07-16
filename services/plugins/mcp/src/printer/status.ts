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
        "Read-only snapshot of the SLS printer: current layer / layer count / build epoch " +
        "(from the plotter), axis positions, per-zone temperatures (current + target, °C), " +
        "power states (laser, heaters, fans), and the active recoater override state " +
        "(staged passes + full-recoat passes). Call this before changing any override to " +
        "understand where the build is.",
      inputSchema: {},
    },
    async () => {
      try {
        const [plotter, snapshot, staged, full] = await Promise.all([
          client.get<PlotterInfo>("/plotter/info"),
          client.get<SnapshotData>("/state/snapshot"),
          client.get<unknown>("/printing/recoater-passes"),
          client.get<unknown>("/printing/recoater-passes-full"),
        ]);
        return jsonResult({
          respondedAt: snapshot.respondedAt,
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
