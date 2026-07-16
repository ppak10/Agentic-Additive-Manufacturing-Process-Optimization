import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";
import { errorResult, jsonResult } from "../result.js";

// Mechanical test results (ASTM D638 tensile, D790 flexural). SLS batches
// A-J plus J_MB, and non-SLS controls (PLA, PETG, and FormLabs-printed
// PA12 GF — material_class 'PA12GF_FL' — useful as the reference target
// when tuning toward TDS properties).

const GROUP_COLS: Record<string, string> = {
  batch: "batch_label",
  standard: "standard",
  material_class: "material_class",
  profile: "profile_name",
};

export function registerDataAstm(server: McpServer) {
  server.registerTool(
    "astm_query",
    {
      title: "Query ASTM mechanical results",
      description:
        "Aggregate or list mechanical test specimens. Grouped mode (default: " +
        "by batch) returns count and mean/std of modulus, peak stress, and " +
        "strain at break, with the print profile named per group — the " +
        "parameters-to-properties picture in one call. Set " +
        "include_specimens for raw per-specimen metrics. Units: Pa " +
        "(aggregates reported in MPa), strain dimensionless.",
      inputSchema: {
        standard: z.enum(["D638", "D790"]).optional(),
        material_class: z
          .string()
          .optional()
          .describe("SLS (default is all), PLA, PETG, or PA12GF_FL"),
        batch: z.string().optional().describe("Batch label, e.g. 'H' or 'J_MB'"),
        job_id: z.string().uuid().optional(),
        group_by: z
          .enum(["batch", "standard", "material_class", "profile", "none"])
          .optional()
          .describe("Aggregation key (default batch); 'none' = one overall row"),
        include_specimens: z
          .boolean()
          .optional()
          .describe("Also return per-specimen rows (metrics only, no curves)"),
      },
    },
    async ({
      standard,
      material_class,
      batch,
      job_id,
      group_by,
      include_specimens,
    }) => {
      try {
        const conds: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, v: unknown) => {
          params.push(v);
          conds.push(`${sql} $${params.length}`);
        };
        if (standard) add("a.standard =", standard);
        if (material_class) add("a.material_class =", material_class);
        if (batch) add("a.batch_label =", batch);
        if (job_id) add("a.job_id =", job_id);
        const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
        const from = `FROM astm_specimens a
          LEFT JOIN inova_print_profiles p ON p.profile_id = a.print_profile_id
          ${where}`;

        const key = GROUP_COLS[group_by ?? "batch"];
        const keySel = key
          ? `a.standard, ${key === "standard" ? "" : (key === "profile_name" ? "p.name AS profile_name, " : `a.${key}, `)}`
          : "";
        const groupExpr = key
          ? `GROUP BY a.standard${key === "standard" ? "" : key === "profile_name" ? ", p.name" : `, a.${key}`}`
          : "";
        const groups = await query(
          `SELECT ${keySel} count(*) AS n,
                  min(p.name) AS profile_name_any,
                  round(avg(a.modulus_pa) / 1e6) AS modulus_mpa_mean,
                  round(stddev(a.modulus_pa) / 1e6) AS modulus_mpa_std,
                  round((avg(a.peak_stress_pa) / 1e6)::numeric, 1) AS peak_stress_mpa_mean,
                  round((stddev(a.peak_stress_pa) / 1e6)::numeric, 1) AS peak_stress_mpa_std,
                  round(avg(a.strain_at_break)::numeric, 4) AS strain_at_break_mean
           ${from} ${groupExpr}
           ORDER BY 1${key && key !== "standard" ? ", 2" : ""}`,
          params,
        );

        let specimens: unknown[] | undefined;
        if (include_specimens) {
          specimens = await query(
            `SELECT a.standard, a.sample_id, a.batch_label, a.material_class,
                    a.test_date, a.job_id, p.name AS profile_name,
                    a.modulus_pa, a.peak_stress_pa, a.strain_at_peak,
                    a.stress_at_break_pa, a.strain_at_break,
                    a.energy_to_break_j, a.test_end_reason, a.notes
             ${from} ORDER BY a.standard, a.batch_label, a.sample_id`,
            params,
          );
        }
        return jsonResult({ groups, ...(specimens ? { specimens } : {}) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
