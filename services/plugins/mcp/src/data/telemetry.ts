import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";
import { errorResult, jsonResult } from "../result.js";

// Per-build telemetry detail from build_summaries: the derived features
// (services/pipeline/agentic_sls/pipeline/summarize_builds.py), not raw 10 Hz ticks. Raw ticks live in the
// telemetry table (new era) / export parquets (old era) if db_query-level
// digging is ever needed.

export function registerDataTelemetry(server: McpServer) {
  server.registerTool(
    "telemetry_summary",
    {
      title: "Get telemetry summary for a build",
      description:
        "Derived telemetry features for one build: duration, recoat and " +
        "print-layer counts, laser duty, power draw, and per-sensor thermal " +
        "tracking error (dev_* = current minus target, °C, while a target " +
        "was set). include_layers adds the per-recoat timeline (start " +
        "offset, duration, laser-on seconds, mean print-bed °C) — use " +
        "layer_range to window it on long builds.",
      inputSchema: {
        build_id: z.number().int(),
        include_layers: z
          .boolean()
          .optional()
          .describe("Include the per-recoat timeline array"),
        layer_range: z
          .tuple([z.number().int().min(1), z.number().int()])
          .optional()
          .describe("Recoat index window [from, to], 1-based inclusive"),
      },
    },
    async ({ build_id, include_layers, layer_range }) => {
      try {
        const [row] = await query(
          `SELECT build_id, source, computed_at, duration_s, n_recoats,
                  n_print_layers, layer_duration_s_median, laser_on_s,
                  power_w_mean, power_w_max, temps
           FROM build_summaries WHERE build_id = $1`,
          [build_id],
        );
        if (!row) {
          return jsonResult({
            error: `no summary for build ${build_id} — not summarized yet or id unknown (see builds_list)`,
          });
        }
        let layers: unknown[] | undefined;
        if (include_layers || layer_range) {
          const [from, to] = layer_range ?? [1, Number.MAX_SAFE_INTEGER];
          const rows = await query<{ layers: unknown[] }>(
            "SELECT layers FROM build_summaries WHERE build_id = $1",
            [build_id],
          );
          layers = (rows[0].layers ?? []).filter((l) => {
            const r = (l as { recoat: number }).recoat;
            return r >= from && r <= to;
          });
        }
        return jsonResult({ ...row, ...(layers ? { layers } : {}) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
