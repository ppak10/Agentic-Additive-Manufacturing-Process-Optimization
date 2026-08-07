import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { errorResult, jsonResult } from "../result.js";

// Print-setup overrides — the firmware's NATIVE mid-print tuning channel
// (IPrintingService.SetupOverrides): the sanctioned way to change laser
// energy and phase temperature targets on a RUNNING print. Distinct from
// layer_overrides (recoating mechanics): these knobs are owned by the
// firmware and reset to empty at every print start, so anything set while
// idle is discarded when the next print begins.

export function registerSetupOverrides(server: McpServer, client: InovaClient) {
  server.registerTool(
    "setup_overrides_get",
    {
      title: "Get print-setup overrides",
      description:
        "Read the firmware's mid-print setup overrides: current override " +
        "values (null = running at the profile's value), the outline energy " +
        "array, and `defaults` — the running profile's baseline for each " +
        "knob (null when not printing). Knobs: " +
        "bedPreparationTemperatureTarget / beginLayerTemperatureTarget / " +
        "printCapTemperatureTarget [°C, 0–200], totalEnergyDensityPercent " +
        "[1–500], laserFillEnergyDensity [0–100 mJ/mm], " +
        "laserOutlineEnergyDensities [array, entries 0–100]. Overrides are " +
        "reset at every print start — they only matter DURING a print.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.get("/printing/setup-overrides"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "setup_overrides_set",
    {
      title: "Set print-setup overrides",
      description:
        "Change laser energy and/or phase temperature targets on the LIVE " +
        "print (takes effect from the next layer). Partial update: only the " +
        "named knobs change; null clears a knob back to the profile value. " +
        "The plugin validates the whole batch before applying anything — a " +
        "bad entry rejects the entire request. Bounds (enforced " +
        "server-side): temperatures 0–200 °C (hard safety policy — if the " +
        "process wants more, say so instead of clamping), " +
        "totalEnergyDensityPercent 1–500, laserFillEnergyDensity 0–100, " +
        "laserOutlineEnergyDensities entries 0–100. Overrides do not " +
        "persist across prints. Read the current state and profile " +
        "baselines with setup_overrides_get first.",
      inputSchema: {
        values: z
          .record(z.union([z.number(), z.array(z.number()), z.null()]))
          .describe(
            'Map of knob → value, e.g. {"totalEnergyDensityPercent": 110, ' +
              '"laserFillEnergyDensity": null, ' +
              '"laserOutlineEnergyDensities": [28, 18]}. null clears a knob.',
          ),
      },
    },
    withActionLog(server, "setup_overrides_set", async ({ values }) => {
      try {
        return jsonResult(
          await client.post("/printing/setup-overrides", { values }),
        );
      } catch (err) {
        return errorResult(err);
      }
    }),
  );
}
