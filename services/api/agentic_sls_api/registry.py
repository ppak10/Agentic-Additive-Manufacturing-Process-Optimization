"""Registry / knowledge / calibration reads for the GUI.

Migrated from the recorder's api/knowledge.ts + api/routes.ts (2026-07-19,
recorder→api phase 2). These are pure Postgres reads (plus one single-statement
calibration insert) against the synced reference tables + recording tables —
zero recorder in-process state, so they belong here, off the recorder's
restart-gated process.
"""

from __future__ import annotations

import json

import psycopg

from .db import pool

# Mirrors PROFILE_KEY_PARAMS in the recorder's knowledge.ts and the MCP
# server's data/builds.ts — the profile fields worth showing on a build card.
PROFILE_KEY_PARAMS = [
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
]

SYNC_HINT = "knowledge tables missing — run sls-sync-reference and sls-summarize-builds"


def fetch_registry() -> list[dict]:
    """Every build joined to session/job/profile/summary — the Builds page list.
    Raises psycopg.errors.UndefinedTable if the sync hasn't run (→ 503 upstream)."""
    with pool.connection() as conn:
        return conn.execute(
            """SELECT r.build_id, r.started_at, r.ended_at, r.inova_session_id,
                      r.session_result, r.job_id, r.job_name, r.profile_id,
                      r.profile_name, r.print_date, r.has_astm,
                      s.n_recoats, s.n_print_layers, s.duration_s, s.laser_on_s,
                      b.notes
               FROM build_registry r
               JOIN builds b ON b.id = r.build_id
               LEFT JOIN build_summaries s USING (build_id)
               ORDER BY r.build_id DESC"""
        ).fetchall()


def fetch_build_card(build_id: int) -> dict | None:
    """Full build card: registry row + summary + key profile params + job
    objects + ASTM outcomes + agent actions. None if the build doesn't exist."""
    with pool.connection() as conn:
        registry = conn.execute(
            """SELECT r.*, b.notes, b.phase,
                      b.params -> 'printingService' ->> 'printProfileName'
                        AS recorded_profile_name
               FROM build_registry r JOIN builds b ON b.id = r.build_id
               WHERE r.build_id = %s""",
            [build_id],
        ).fetchone()
        if registry is None:
            return None

        summary = conn.execute(
            """SELECT source, computed_at, duration_s, n_recoats, n_print_layers,
                      layer_duration_s_median, laser_on_s, power_w_mean,
                      power_w_max, temps, layers
               FROM build_summaries WHERE build_id = %s""",
            [build_id],
        ).fetchone()

        profile_key_params = None
        if registry.get("profile_id"):
            prow = conn.execute(
                "SELECT profile FROM inova_print_profiles WHERE profile_id = %s",
                [registry["profile_id"]],
            ).fetchone()
            profile = prow["profile"] if prow else None
            if profile:
                profile_key_params = {k: profile.get(k) for k in PROFILE_KEY_PARAMS}

        objects = None
        astm: list[dict] = []
        if registry.get("job_id"):
            jrow = conn.execute(
                """SELECT objects FROM inova_jobs
                   WHERE job_id = %s ORDER BY abs(print_date - %s::date) LIMIT 1""",
                [registry["job_id"], registry["print_date"]],
            ).fetchone()
            objects = jrow["objects"] if jrow else None
            astm = conn.execute(
                """SELECT standard, batch_label, count(*) AS n,
                          round(avg(modulus_pa) / 1e6) AS modulus_mpa_mean,
                          round(stddev(modulus_pa) / 1e6) AS modulus_mpa_std,
                          round((avg(peak_stress_pa) / 1e6)::numeric, 1)
                            AS peak_stress_mpa_mean,
                          round(avg(strain_at_break)::numeric, 4)
                            AS strain_at_break_mean
                   FROM astm_specimens WHERE job_id = %s
                   GROUP BY standard, batch_label ORDER BY standard, batch_label""",
                [registry["job_id"]],
            ).fetchall()

        try:
            actions = conn.execute(
                """SELECT ts, harness, tool, arguments, result, is_error
                   FROM agent_actions WHERE build_id = %s ORDER BY ts""",
                [build_id],
            ).fetchall()
        except psycopg.errors.UndefinedTable:
            actions = []  # table appears on first agent action; autocommit → no abort

        return {
            "registry": registry,
            "summary": summary,
            "profile_key_params": profile_key_params,
            "objects": objects,
            "astm_outcomes": astm,
            "agent_actions": actions,
        }


def fetch_datasets_summary() -> dict:
    """Per-dataset row counts for the Datasets pages. Big tables use pg_class
    reltuples ESTIMATES (exact count(*) over telemetry takes minutes)."""
    with pool.connection() as conn:

        def est(table: str) -> int:
            r = conn.execute(
                "SELECT reltuples::bigint AS n FROM pg_class WHERE relname = %s", [table]
            ).fetchone()
            return max(0, int(r["n"]) if r and r["n"] is not None else 0)

        def exact(table: str) -> int:
            # table names are hardcoded constants below — never user input
            r = conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()
            return int(r["n"]) if r else 0

        return {
            "telemetry": {
                "builds": exact("builds"),
                "events": exact("events"),
                "ticks_est": est("telemetry"),
                "frames_est": est("frames"),
                "position_est": est("position_hf"),
            },
            "database": {
                "jobs": exact("inova_jobs"),
                "profiles": exact("inova_print_profiles"),
                "print_sessions": exact("inova_print_sessions"),
            },
            "astm": {"specimens": exact("astm_specimens")},
            "conversations": {
                "conversations": exact("agent_conversations"),
                "sessions": exact("agent_sessions"),
                "selections": exact("agent_selections"),
                "messages_est": est("agent_messages"),
                "conversation_builds": exact("conversation_builds"),
            },
        }


def get_calibration(kind: str) -> dict | None:
    with pool.connection() as conn:
        return conn.execute(
            """SELECT id, kind, payload, source, note, created_at FROM calibrations
               WHERE kind = %s ORDER BY id DESC LIMIT 1""",
            [kind],
        ).fetchone()


def insert_calibration(kind: str, payload: dict, source: str | None, note: str | None) -> dict:
    with pool.connection() as conn:
        return conn.execute(
            """INSERT INTO calibrations (kind, payload, source, note)
               VALUES (%s, %s, %s, %s) RETURNING id, created_at""",
            [kind, json.dumps(payload), source, note],
        ).fetchone()
