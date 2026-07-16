import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db.js";
import { errorResult, jsonResult } from "../result.js";

// Build catalog + build cards. The registry (build_registry view) links a
// recorder build to its firmware print session, job, profile, and ASTM
// coverage; build_summaries carries the derived telemetry features. Failed
// and aborted builds are included on purpose — how a profile failed is as
// informative as how it succeeded.

// The print profile fields an agent actually reasons over when comparing
// builds. The full ~100-field JSON is available via db_query on
// inova_print_profiles.
const PROFILE_KEY_PARAMS = [
  "Material",
  "LaserFillEnergyDensity",
  "TotalEnergyDensityPercent",
  "LayerThickness",
  "HeatingTargetPrint",
  "HeatingTargetPrintBed",
  "BedPreparationTemperatureTarget",
  "BeginLayerTemperatureTarget",
  "PrintCapTemperatureTarget",
  "SurfaceTarget",
  "SurfaceTarget2",
  "RecoaterPasses",
  "RecoaterPowderSpeedPercent",
  "RecoaterPrintSpeedPercent",
  "PowderVolumePercent",
  "OutlineCount",
  "HotspotOverlapPercent",
  "SinteredVolumeFactor",
  "HeatingMinimumTime",
  "CoolingMinimumTime",
];

export function registerDataBuilds(server: McpServer) {
  server.registerTool(
    "builds_list",
    {
      title: "List recorded builds",
      description:
        "Catalog of recorded printer builds (completed, failed, and aborted), " +
        "joined to firmware session / job / print profile and telemetry " +
        "summary headlines. At the current corpus size the unfiltered list " +
        "is small — browse it, then drill in with build_get. " +
        "session_result: 0=incomplete, 1=completed, 2=cancelled.",
      inputSchema: {
        has_astm: z
          .boolean()
          .optional()
          .describe("Only builds whose job has mechanical test specimens"),
        printed_only: z
          .boolean()
          .optional()
          .describe("Only builds that sintered at least one layer"),
        profile: z
          .string()
          .optional()
          .describe("Substring match on print profile name, e.g. '32mJ'"),
        since: z.string().optional().describe("ISO date lower bound"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ has_astm, printed_only, profile, since, limit }) => {
      try {
        const conds: string[] = [];
        const params: unknown[] = [];
        if (has_astm) conds.push("r.has_astm");
        if (printed_only) conds.push("coalesce(s.n_print_layers, 0) > 0");
        if (profile) {
          params.push(`%${profile}%`);
          conds.push(`r.profile_name ILIKE $${params.length}`);
        }
        if (since) {
          params.push(since);
          conds.push(`r.started_at >= $${params.length}`);
        }
        params.push(limit ?? 100);
        const rows = await query(
          `SELECT r.build_id, r.started_at::date AS date, r.job_name,
                  r.profile_name, r.session_result, r.has_astm,
                  s.n_print_layers, round((s.duration_s / 3600)::numeric, 1)
                    AS duration_h, s.laser_on_s
           FROM build_registry r
           LEFT JOIN build_summaries s USING (build_id)
           ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
           ORDER BY r.build_id
           LIMIT $${params.length}`,
          params,
        );
        return jsonResult({ builds: rows, count: rows.length });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "build_get",
    {
      title: "Get a build card",
      description:
        "Everything known about one build: recorder metadata and notes, " +
        "firmware session outcome, job and printed objects, the print " +
        "profile's key parameters, telemetry summary (thermal tracking " +
        "error per sensor, layer counts, laser duty), and per-batch ASTM " +
        "outcomes for its job. Per-layer detail lives in telemetry_summary.",
      inputSchema: {
        build_id: z.number().int().describe("Recorder build id"),
      },
    },
    async ({ build_id }) => {
      try {
        const [reg] = await query(
          `SELECT r.*, b.notes,
                  b.params -> 'printingService' ->> 'printProfileName'
                    AS recorded_profile_name
           FROM build_registry r JOIN builds b ON b.id = r.build_id
           WHERE r.build_id = $1`,
          [build_id],
        );
        if (!reg) return jsonResult({ error: `no build ${build_id}` });

        const [summary] = await query(
          `SELECT source, duration_s, n_recoats, n_print_layers,
                  layer_duration_s_median, laser_on_s, power_w_mean,
                  power_w_max, temps
           FROM build_summaries WHERE build_id = $1`,
          [build_id],
        );

        let profileKeyParams: Record<string, unknown> | null = null;
        if (reg.profile_id) {
          const [p] = await query<{ profile: Record<string, unknown> }>(
            "SELECT profile FROM inova_print_profiles WHERE profile_id = $1",
            [reg.profile_id],
          );
          if (p) {
            profileKeyParams = Object.fromEntries(
              PROFILE_KEY_PARAMS.map((k) => [k, p.profile[k]]),
            );
          }
        }

        let objects: unknown = null;
        let astm: unknown[] = [];
        if (reg.job_id) {
          const [job] = await query(
            `SELECT objects FROM inova_jobs
             WHERE job_id = $1 ORDER BY abs(print_date - $2::date) LIMIT 1`,
            [reg.job_id, reg.print_date],
          );
          objects = job?.objects ?? null;
          astm = await query(
            `SELECT standard, batch_label, count(*) AS n,
                    round(avg(modulus_pa) / 1e6) AS modulus_mpa_mean,
                    round(stddev(modulus_pa) / 1e6) AS modulus_mpa_std,
                    round((avg(peak_stress_pa) / 1e6)::numeric, 1) AS peak_stress_mpa_mean,
                    round(avg(strain_at_break)::numeric, 4) AS strain_at_break_mean
             FROM astm_specimens WHERE job_id = $1
             GROUP BY standard, batch_label ORDER BY standard, batch_label`,
            [reg.job_id],
          );
        }

        return jsonResult({
          registry: reg,
          telemetry_summary: summary ?? null,
          profile_key_params: profileKeyParams,
          objects,
          astm_outcomes: astm,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
