import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { errorResult, jsonResult } from "../result.js";

// Staged recoater passes: the firmware's Thickness-division mode. N passes
// each deliver 1/N of the layer's powder, followed by one finishing pass —
// powder is staged WITHIN a single layer, not repeated. Contrast with
// recoater_full_passes_set, which expands each layer into N full recoat
// cycles.

const SEMANTICS =
  "Staged powder delivery WITHIN one layer (firmware 'Thickness' division mode): " +
  "N passes each deposit 1/N of the layer's powder, plus one finishing pass. " +
  "This does NOT repeat full recoats — for that use recoater_full_passes_set. " +
  "Changes take effect on the NEXT layer (the current layer's plan is already " +
  "committed). profileDefault is the running print profile's value, used when " +
  "no override is set.";

export function registerRecoaterPasses(server: McpServer, client: InovaClient) {
  server.registerTool(
    "recoater_passes_get",
    {
      title: "Get staged recoater passes",
      description:
        `Read the runtime staged-recoater-passes override. ${SEMANTICS} ` +
        "Returns the live override value (iOptions/iOptionsMonitor), the saved " +
        "state that survives config reloads, and profileDefault.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.get("/printing/recoater-passes"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "recoater_passes_set",
    {
      title: "Set staged recoater passes",
      description:
        `Set or clear the staged-recoater-passes override on a LIVE print. ${SEMANTICS}`,
      inputSchema: {
        value: z
          .union([z.number().int().min(1).max(5), z.null()])
          .describe(
            "Passes per layer, 1–5. null clears the override (reverts to the print profile's value).",
          ),
      },
    },
    async ({ value }) => {
      try {
        return jsonResult(
          await client.post("/printing/recoater-passes", { value }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
