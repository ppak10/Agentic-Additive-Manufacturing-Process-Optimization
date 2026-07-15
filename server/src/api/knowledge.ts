// Knowledge/registry routes for the Builds GUI page — the human-facing view
// of the same build cards the MCP data_* tools serve to agents.
//
// NOT yet imported by routes.ts on purpose: server/src hot-reloads into the
// live recorder (tsx watch), so wiring happens at a maintenance window with
// the recorder stopped. Until then this module is inert.
//
// Depends on tables/views created by sls-sync-reference and
// sls-summarize-builds (agentic_sls/pipeline/); every handler degrades to a hint if the
// sync hasn't run.
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

// Mirrors PROFILE_KEY_PARAMS in plugin/src/data/builds.ts — the profile
// fields worth showing when comparing builds.
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
] as const;

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: string })?.code === "42P01";
}

const SYNC_HINT =
  "knowledge tables missing — run sls-sync-reference and sls-summarize-builds";

export async function registerKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/registry", async (_req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.build_id, r.started_at, r.ended_at, r.inova_session_id,
                r.session_result, r.job_id, r.job_name, r.profile_id,
                r.profile_name, r.print_date, r.has_astm,
                s.n_recoats, s.n_print_layers, s.duration_s, s.laser_on_s,
                b.notes
         FROM build_registry r
         JOIN builds b ON b.id = r.build_id
         LEFT JOIN build_summaries s USING (build_id)
         ORDER BY r.build_id DESC`,
      );
      return rows;
    } catch (err) {
      if (isMissingRelation(err)) return reply.code(503).send({ error: SYNC_HINT });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/registry/:id/card",
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad id" });
      try {
        const { rows: regRows } = await pool.query(
          `SELECT r.*, b.notes, b.phase,
                  b.params -> 'printingService' ->> 'printProfileName'
                    AS recorded_profile_name
           FROM build_registry r JOIN builds b ON b.id = r.build_id
           WHERE r.build_id = $1`,
          [id],
        );
        const registry = regRows[0];
        if (!registry) return reply.code(404).send({ error: `no build ${id}` });

        const { rows: sumRows } = await pool.query(
          `SELECT source, computed_at, duration_s, n_recoats, n_print_layers,
                  layer_duration_s_median, laser_on_s, power_w_mean,
                  power_w_max, temps, layers
           FROM build_summaries WHERE build_id = $1`,
          [id],
        );

        let profileKeyParams: Record<string, unknown> | null = null;
        if (registry.profile_id) {
          const { rows } = await pool.query(
            "SELECT profile FROM inova_print_profiles WHERE profile_id = $1",
            [registry.profile_id],
          );
          const profile = rows[0]?.profile as Record<string, unknown> | undefined;
          if (profile) {
            profileKeyParams = Object.fromEntries(
              PROFILE_KEY_PARAMS.map((k) => [k, profile[k]]),
            );
          }
        }

        let objects: unknown = null;
        let astm: unknown[] = [];
        if (registry.job_id) {
          const { rows: jobRows } = await pool.query(
            `SELECT objects FROM inova_jobs
             WHERE job_id = $1 ORDER BY abs(print_date - $2::date) LIMIT 1`,
            [registry.job_id, registry.print_date],
          );
          objects = jobRows[0]?.objects ?? null;
          const { rows: astmRows } = await pool.query(
            `SELECT standard, batch_label, count(*) AS n,
                    round(avg(modulus_pa) / 1e6) AS modulus_mpa_mean,
                    round(stddev(modulus_pa) / 1e6) AS modulus_mpa_std,
                    round((avg(peak_stress_pa) / 1e6)::numeric, 1)
                      AS peak_stress_mpa_mean,
                    round(avg(strain_at_break)::numeric, 4)
                      AS strain_at_break_mean
             FROM astm_specimens WHERE job_id = $1
             GROUP BY standard, batch_label ORDER BY standard, batch_label`,
            [registry.job_id],
          );
          astm = astmRows;
        }

        let actions: unknown[] = [];
        try {
          const { rows } = await pool.query(
            `SELECT ts, harness, tool, arguments, result, is_error
             FROM agent_actions WHERE build_id = $1 ORDER BY ts`,
            [id],
          );
          actions = rows;
        } catch (err) {
          if (!isMissingRelation(err)) throw err; // table appears on first log
        }

        return {
          registry,
          summary: sumRows[0] ?? null,
          profile_key_params: profileKeyParams,
          objects,
          astm_outcomes: astm,
          agent_actions: actions,
        };
      } catch (err) {
        if (isMissingRelation(err)) return reply.code(503).send({ error: SYNC_HINT });
        throw err;
      }
    },
  );
}
