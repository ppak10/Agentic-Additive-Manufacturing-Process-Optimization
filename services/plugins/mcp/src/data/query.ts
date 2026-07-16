import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";
import { errorResult, jsonResult } from "../result.js";

// Escape hatch for questions the curated tools don't anticipate. Defense in
// depth: this gate allows only a single SELECT/WITH statement, and the pool
// itself runs default_transaction_read_only with a 10 s statement timeout —
// so even a clever bypass of the regex cannot write.

const MAX_ROWS_DEFAULT = 100;

const SCHEMA_HINT = `Key tables/views:
  build_registry (view)  build_id, started_at, ended_at, inova_session_id,
                         session_result, job_id, job_name, profile_id,
                         profile_name, print_date, has_astm
  builds                 id, job_name, started_at, ended_at, phase, params, notes
  build_summaries        build_id, duration_s, n_recoats, n_print_layers,
                         layer_duration_s_median, laser_on_s, power_w_*, temps, layers
  astm_specimens         standard, sample_id, batch_label, material_class,
                         job_id, print_profile_id, modulus_pa, peak_stress_pa,
                         strain_at_break, ... (metrics in Pa)
  inova_jobs             source_file, job_id, job_name, print_date,
                         print_profile_id, objects, metadata
  inova_print_profiles   profile_id, name, profile (full JSON)
  inova_print_sessions   session_id, start_time, complete_time, result,
                         job_id, job_name, profile_id, profile_name, exception
  telemetry              build_id, ts, sensor_id, kind, value (10 Hz skinny;
                         new-era builds only — old era lives in parquet exports)
  events, frames, position_hf, recording_health_events`;

// First gate for db_query; the read-only pool is the backstop. Exported for
// tests. Throws on anything that isn't a single SELECT/WITH statement and
// returns the statement with any trailing semicolon stripped.
export function gateSql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^\s*(select|with)\b/i.test(trimmed)) {
    throw new Error("only SELECT/WITH statements are allowed");
  }
  if (trimmed.includes(";")) {
    throw new Error("multiple statements are not allowed");
  }
  return trimmed;
}

export function registerDataQuery(server: McpServer) {
  server.registerTool(
    "db_query",
    {
      title: "Read-only SQL query",
      description:
        "Run a single read-only SQL statement against the recorder database " +
        "when the curated tools don't cover the question. Connection is " +
        "forced read-only with a 10 s statement timeout; results are " +
        `row-capped. ${SCHEMA_HINT}`,
      inputSchema: {
        sql: z.string().describe("One SELECT or WITH statement"),
        max_rows: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ sql, max_rows }) => {
      try {
        const trimmed = gateSql(sql);
        const cap = max_rows ?? MAX_ROWS_DEFAULT;
        const rows = await query(
          `SELECT * FROM (${trimmed}) _q LIMIT ${cap + 1}`,
        );
        const truncated = rows.length > cap;
        return jsonResult({
          rows: truncated ? rows.slice(0, cap) : rows,
          count: Math.min(rows.length, cap),
          ...(truncated ? { truncated: true } : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
