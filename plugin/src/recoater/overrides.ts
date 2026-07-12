import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { errorResult, jsonResult } from "../result.js";

interface OverrideField {
  name: string;
  kind: string;
  min: number | null;
  max: number | null;
  iOptions: number | null;
  iOptionsMonitor: number | null;
  savedState: number | null;
  profileValue: number | null;
}

export function registerLayerOverrides(server: McpServer, client: InovaClient) {
  server.registerTool(
    "layer_overrides_get",
    {
      title: "Get layer overrides",
      description:
        "List every runtime-overridable LayerClientOptions knob (recoater speeds, " +
        "shake, powder dosing, Z clearance, delays) with its kind, allowed min/max, " +
        "live value (iOptionsMonitor), saved override state, and profileValue (the " +
        "running print profile's baseline). A knob with savedState=null is running " +
        "at its profile value. ALWAYS call this before layer_overrides_set — the " +
        "knob names and ranges come from the firmware's registry, not from this " +
        "tool. TimeSpan knobs are expressed as fractional seconds.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.get<{ fields: OverrideField[] }>(
          "/printing/layer-overrides",
        );
        // Compact: drop the duplicate iOptions handle (iOptionsMonitor is the
        // live value) so the field list stays cheap to re-read.
        return jsonResult({
          respondedAt: res.respondedAt,
          fields: res.data.fields.map(
            ({ name, kind, min, max, iOptionsMonitor, savedState, profileValue }) => ({
              name,
              kind,
              min,
              max,
              live: iOptionsMonitor,
              saved: savedState,
              profileValue,
            }),
          ),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "layer_overrides_set",
    {
      title: "Set layer overrides",
      description:
        "Set or clear one or more LayerClientOptions runtime overrides on a LIVE " +
        "print. Partial update: only the named knobs change; null clears a knob " +
        "back to its profile value. Knob names, kinds, and min/max ranges come " +
        "from layer_overrides_get — call it first. The firmware validates the " +
        "whole batch before applying anything, so a bad entry rejects the entire " +
        "request (no partial writes). Changes take effect on the NEXT layer. " +
        "TimeSpan knobs take fractional seconds. Saved overrides are re-applied " +
        "on firmware config reload.",
      inputSchema: {
        values: z
          .record(z.union([z.number(), z.null()]))
          .describe(
            'Map of knob name → new value, e.g. {"recoaterPrintSpeedFactorOverride": 0.8, "zMoveForce": null}. null clears the knob.',
          ),
      },
    },
    withActionLog(server, "layer_overrides_set", async ({ values }) => {
      try {
        return jsonResult(
          await client.post("/printing/layer-overrides", { values }),
        );
      } catch (err) {
        return errorResult(err);
      }
    }),
  );
}
