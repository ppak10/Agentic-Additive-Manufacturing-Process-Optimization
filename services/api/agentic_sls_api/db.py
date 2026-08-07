"""Postgres access for the GUI API service.

A single small connection pool (psycopg3) opened at app startup. Endpoints are
sync `def` handlers — FastAPI runs them in a threadpool and the pool is
thread-safe, so this stays simple and correct without an async driver.

DATABASE_URL is the same DSN every service uses (see .env). Under
`network_mode: host` in compose it resolves Postgres at localhost:5432, exactly
like the recorder and tasks services.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

load_dotenv()

_DSN = os.environ.get("DATABASE_URL")
if not _DSN:
    raise RuntimeError("DATABASE_URL is not set (check .env)")

# open=False: the pool is opened from the FastAPI lifespan hook (server.py) so
# a Postgres blip at boot doesn't crash import; requests just wait for a conn.
# autocommit: this service is read-heavy with the occasional single-statement
# insert (calibrations). Autocommit connections avoid transaction-abort cascades
# when an optional table is missing mid-request (e.g. agent_actions on a fresh DB
# — see registry.fetch_build_card).
pool = ConnectionPool(
    _DSN,
    min_size=1,
    max_size=4,
    open=False,
    kwargs={"row_factory": dict_row, "autocommit": True},
)


def ping() -> None:
    """Cheap liveness probe used by /health."""
    with pool.connection() as conn:
        conn.execute("SELECT 1")


# One row per tested ASTM specimen (astm_specimens is flattened metrics),
# joined to its printed job's name via the nearest-print_date lateral join the
# build card uses to disambiguate reprinted jobs. Metrics stay in SI (Pa/N/J);
# the GUI formats to MPa. Control specimens (PLA/PETG/FormLabs) have a null
# job_id and simply show no job link.
_ASTM_SQL = """
SELECT a.standard, a.sample_id, a.batch_label, a.material_class,
       a.test_date, a.job_id, a.print_date, a.inova_session_id,
       a.modulus_pa, a.peak_load_n, a.peak_stress_pa, a.strain_at_peak,
       a.stress_at_break_pa, a.strain_at_break, a.energy_to_break_j,
       a.yield_stress_pa, a.strain_at_yield, a.test_end_reason, a.notes,
       j.job_name
FROM astm_specimens a
LEFT JOIN LATERAL (
    SELECT job_name FROM inova_jobs
    WHERE job_id = a.job_id
    ORDER BY abs(print_date - a.print_date) LIMIT 1
) j ON true
ORDER BY a.test_date DESC NULLS LAST, a.standard, a.sample_id
"""


def fetch_astm() -> list[dict]:
    with pool.connection() as conn:
        return conn.execute(_ASTM_SQL).fetchall()


# ── process map ──────────────────────────────────────────────────────────────
# Curated profile fields the Process Map page offers as parameter axes.
# Values come from each specimen's print-time snapshot (print_profile_snapshot),
# NOT the live profile row — profiles are upserted in place, so only the
# snapshot preserves what the specimen was actually printed with.
PROCESS_MAP_PARAMS = [
    "EffectiveLineEnergyDensity",  # derived, see fetch_process_map
    "LaserFillEnergyDensity",
    "LaserFirstOutlineEnergyDensity",
    "LaserOtherOutlineEnergyDensity",
    "TotalEnergyDensityPercent",
    "LaserOnPercent",
    "OutlineCount",
    "HotspotOverlapPercent",
    "LayerThickness",
    "HeatingTargetPrint",
    "HeatingTargetPrintBed",
    "SurfaceTarget",
    "SurfaceTarget2",
    "BeginLayerTemperatureTarget",
    "BedPreparationTemperatureTarget",
    "RecoaterPasses",
    "PowderVolumePercent",
]

# One point per SLS specimen that carries a print-time profile snapshot
# (controls have none). `- 'Stats'` strips the ~170 KB per-row stats blob
# inside Postgres, before it crosses the wire. Job-name lateral join mirrors
# _ASTM_SQL.
_PROCESS_MAP_SQL = """
SELECT a.standard, a.sample_id, a.batch_label, a.material_class,
       a.test_date, a.job_id, a.print_date, a.print_profile_id,
       a.modulus_pa, a.peak_stress_pa, a.strain_at_peak,
       a.stress_at_break_pa, a.strain_at_break, a.energy_to_break_j,
       a.test_end_reason,
       a.print_profile_snapshot - 'Stats' AS snapshot,
       j.job_name
FROM astm_specimens a
LEFT JOIN LATERAL (
    SELECT job_name FROM inova_jobs
    WHERE job_id = a.job_id
    ORDER BY abs(print_date - a.print_date) LIMIT 1
) j ON true
WHERE a.print_profile_snapshot IS NOT NULL
ORDER BY a.standard, a.sample_id
"""


def fetch_process_map() -> dict:
    with pool.connection() as conn:
        rows = conn.execute(_PROCESS_MAP_SQL).fetchall()
    points = []
    for row in rows:
        snapshot = row.pop("snapshot") or {}
        row["profile_name"] = snapshot.get("Name")
        params = {k: snapshot.get(k) for k in PROCESS_MAP_PARAMS}
        # The firmware exposes no direct laser power / scan speed — its energy
        # knob LaserFillEnergyDensity is LINE energy density (mJ per mm of scan
        # path, i.e. P/v), globally scaled by TotalEnergyDensityPercent. The
        # derived effective value is the physically comparable energy axis.
        # LaserOnPercent is deliberately NOT folded in: its composition with
        # the ED model is unconfirmed (100 in every profile printed so far).
        fill = snapshot.get("LaserFillEnergyDensity")
        total_pct = snapshot.get("TotalEnergyDensityPercent")
        params["EffectiveLineEnergyDensity"] = (
            round(fill * (total_pct / 100), 2)
            if fill is not None and total_pct is not None
            else fill
        )
        row["params"] = params
        points.append(row)
    return {"params": PROCESS_MAP_PARAMS, "points": points}
