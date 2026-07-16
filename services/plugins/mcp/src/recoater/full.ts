import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { errorResult, jsonResult } from "../result.js";

// Full-recoat passes: expands each layer into N complete recoat cycles via
// the FullRecoatLayerClient substitution in the firmware's DI registration.
// Distinct from staged passes (recoater_passes_set), which divide powder
// delivery WITHIN a single layer.

const SEMANTICS =
  "Expands each printed layer into N complete recoat cycles (full powder dose " +
  "and sweep each time) via the FullRecoatLayerClient substitution. 1 = " +
  "passthrough. powder=false makes repeats dry sweeps (no extra powder dose). " +
  "This is NOT the same as recoater_passes_set, which stages 1/N powder " +
  "delivery within one layer. Changes take effect on the NEXT layer. " +
  "IMPORTANT: if replacementActive is false in the response, the LayerClient " +
  "substitution did not load and this override is a NO-OP — report that " +
  "instead of assuming the change applied.";

export function registerRecoaterFullPasses(
  server: McpServer,
  client: InovaClient,
) {
  server.registerTool(
    "recoater_full_passes_get",
    {
      title: "Get full-recoat passes",
      description:
        `Read the full-recoat passes override and whether the substitution is active. ${SEMANTICS}`,
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.get("/printing/recoater-passes-full"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "recoater_full_passes_set",
    {
      title: "Set full-recoat passes",
      description: `Set or clear the full-recoat passes override on a LIVE print. ${SEMANTICS}`,
      inputSchema: {
        value: z
          .union([z.number().int().min(1).max(5), z.null()])
          .describe(
            "Full recoat cycles per layer, 1–5 (1 = passthrough). null clears the override.",
          ),
        powder: z
          .boolean()
          .optional()
          .describe(
            "Whether repeat passes dose fresh powder (true, default) or run dry sweeps (false). Omit to leave unchanged.",
          ),
      },
    },
    withActionLog(server, "recoater_full_passes_set", async ({ value, powder }) => {
      try {
        const body: Record<string, unknown> = { value };
        if (powder !== undefined) body.powder = powder;
        return jsonResult(
          await client.post("/printing/recoater-passes-full", body),
        );
      } catch (err) {
        return errorResult(err);
      }
    }),
  );
}
