"""Sync firmware- and lab-origin reference data into Postgres.

Postgres is the agent's single query surface, but jobs/profiles/sessions
originate in the printer firmware (harvested into Agentic-SLS-Database) and
mechanical results originate in the test lab (harvested into Agentic-SLS-ASTM).
This script maintains synced copies as reference tables:

  inova_jobs            one row per Formlabs job (.s4a metadata)
  inova_print_profiles  one row per print profile (full JSON + name)
  inova_print_sessions  one row per firmware PrintSession
  astm_specimens        one row per tested specimen, metrics flattened

Copies, not sources of truth: corrections happen at the origin repos and
re-sync. Each run is a full truncate-and-reload in one transaction, so the
script is idempotent and deletions at the origin propagate. DDL lives here
(CREATE TABLE IF NOT EXISTS) rather than in server/src/db/schema.sql — the
recorder never touches these tables.

Usage:
  uv run sls-sync-reference
  uv run sls-sync-reference --database-repo ... --astm-repo ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from dotenv import load_dotenv


# Database and ASTM live in-repo as submodules under datasets/.
DATASETS_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent / "datasets"

DDL = """
-- One row per .s4a archive = per print instance. The same firmware job
-- UUID can recur (a job reprinted on a later date gets a new archive),
-- so job_id is indexed but not unique.
CREATE TABLE IF NOT EXISTS inova_jobs (
  source_file       TEXT PRIMARY KEY,
  job_id            UUID NOT NULL,
  job_name          TEXT,
  print_date        DATE,
  print_profile_id  UUID,
  objects           JSONB,
  metadata          JSONB
);
CREATE INDEX IF NOT EXISTS inova_jobs_job_id_idx ON inova_jobs (job_id);

CREATE TABLE IF NOT EXISTS inova_print_profiles (
  profile_id  UUID PRIMARY KEY,
  name        TEXT,
  profile     JSONB
);

CREATE TABLE IF NOT EXISTS inova_print_sessions (
  session_id    UUID PRIMARY KEY,
  start_time    TIMESTAMPTZ,
  complete_time TIMESTAMPTZ,
  result        INT,
  job_id        UUID,
  job_name      TEXT,
  profile_id    UUID,
  profile_name  TEXT,
  exception     TEXT,
  session       JSONB
);

CREATE TABLE IF NOT EXISTS astm_specimens (
  standard            TEXT NOT NULL,
  sample_id           TEXT NOT NULL,
  batch_label         TEXT,
  material_class      TEXT,
  test_date           DATE,
  job_id              UUID,
  print_date          DATE,
  print_profile_id    UUID,
  object_hash         TEXT,
  inova_session_id    UUID,
  geometry            JSONB,
  modulus_pa          DOUBLE PRECISION,
  peak_load_n         DOUBLE PRECISION,
  peak_stress_pa      DOUBLE PRECISION,
  strain_at_peak      DOUBLE PRECISION,
  load_at_break_n     DOUBLE PRECISION,
  stress_at_break_pa  DOUBLE PRECISION,
  strain_at_break     DOUBLE PRECISION,
  energy_to_break_j   DOUBLE PRECISION,
  yield_stress_pa     DOUBLE PRECISION,
  strain_at_yield     DOUBLE PRECISION,
  test_end_reason     TEXT,
  notes               TEXT,
  print_profile_snapshot JSONB,
  source_paths        JSONB,
  PRIMARY KEY (standard, sample_id)
);
"""

# The registry: one row per recorder build, joined through its firmware
# session to job / profile / ASTM coverage. builds.inova_session_id is the
# bridge (backfilled by match_build_sessions.py, stamped live going forward).
# The lateral job join disambiguates reprinted jobs (same job_id, two .s4a
# archives) by picking the archive whose print_date is nearest the session.
REGISTRY_VIEW = """
CREATE OR REPLACE VIEW build_registry AS
SELECT
  b.id                 AS build_id,
  b.started_at,
  b.ended_at,
  b.inova_session_id,
  s.result             AS session_result,
  s.job_id,
  COALESCE(s.job_name, b.job_name) AS job_name,
  s.profile_id,
  s.profile_name,
  j.print_date,
  j.source_file        AS job_archive,
  EXISTS (SELECT 1 FROM astm_specimens a WHERE a.job_id = s.job_id)
                       AS has_astm
FROM builds b
LEFT JOIN inova_print_sessions s ON s.session_id = b.inova_session_id
LEFT JOIN LATERAL (
  SELECT * FROM inova_jobs j
  WHERE j.job_id = s.job_id
  ORDER BY abs(j.print_date - s.start_time::date) LIMIT 1
) j ON true
-- builds folded into another by sls-merge-builds are hidden (their rows
-- survive as tombstones so references still resolve; see merge_builds.py)
WHERE b.merged_into IS NULL;
"""

# merged_into: tombstone pointer written by sls-merge-builds when a build is
# folded into its canonical sibling (recorder restart split one PrintSession
# across two build ids). The column must exist before the view references it.
BUILDS_MERGED_INTO_DDL = (
    "ALTER TABLE builds ADD COLUMN IF NOT EXISTS "
    "merged_into bigint REFERENCES builds(id)"
)

METRIC_COLS = ["modulus_pa", "peak_load_n", "peak_stress_pa", "strain_at_peak",
               "load_at_break_n", "stress_at_break_pa", "strain_at_break",
               "energy_to_break_j", "yield_stress_pa", "strain_at_yield"]


def norm_date(s: str | None) -> str | None:
    return s.replace("_", "-") if s else None


def jsonb(v) -> Jsonb | None:
    return Jsonb(v) if v is not None else None


def sync_jobs(conn, database_repo: Path) -> int:
    n = 0
    with (database_repo / "data" / "jobs.jsonl").open() as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            conn.execute(
                "INSERT INTO inova_jobs (source_file, job_id, job_name,"
                " print_date, print_profile_id, objects, metadata)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                [r.get("source_file"), r["metadata"]["AutomaticJob"]["Id"],
                 r.get("job_name"), norm_date(r.get("print_date")),
                 r.get("print_profile_id"), jsonb(r.get("objects")),
                 jsonb(r.get("metadata"))])
            n += 1
    return n


def sync_profiles(conn, database_repo: Path) -> int:
    n = 0
    for path in sorted((database_repo / "source" / "PrintProfiles").glob("*.json")):
        d = json.loads(path.read_text())
        conn.execute(
            "INSERT INTO inova_print_profiles (profile_id, name, profile)"
            " VALUES (%s, %s, %s)",
            [d["Id"], d.get("Name"), Jsonb(d)])
        n += 1
    return n


def sync_sessions(conn, database_repo: Path) -> int:
    n = 0
    for path in sorted((database_repo / "source" / "PrintSessions").glob("*.json")):
        d = json.loads(path.read_text())
        conn.execute(
            "INSERT INTO inova_print_sessions (session_id, start_time,"
            " complete_time, result, job_id, job_name, profile_id,"
            " profile_name, exception, session)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            [d["Id"], d.get("StartTime"), d.get("CompleteTime"),
             d.get("Result"), d.get("JobId"), d.get("JobName"),
             d.get("ProfileId"), d.get("ProfileName"),
             d.get("ExceptionString"), Jsonb(d)])
        n += 1
    return n


def sync_specimens(conn, astm_repo: Path) -> int:
    n = 0
    for path in sorted((astm_repo / "data").glob("D*/**/*.jsonl")):
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            metrics = r.get("metrics") or {}
            # Control specimens (PLA/PETG/FormLabs) have no batch sample_id;
            # the file stem (e.g. PA12GF_FL_TSR1) is their stable identifier.
            sample_id = r.get("sample_id") or path.stem
            conn.execute(
                "INSERT INTO astm_specimens (standard, sample_id, batch_label,"
                " material_class, test_date, job_id, print_date,"
                " print_profile_id, object_hash, inova_session_id, geometry, "
                + ", ".join(METRIC_COLS) +
                ", test_end_reason, notes, print_profile_snapshot,"
                " source_paths) VALUES (" + ", ".join(["%s"] * 25) + ")",
                [r["astm"]["standard"], sample_id, r.get("batch_label"),
                 r.get("material_class"), norm_date(r.get("test_date")),
                 r.get("job_id"), norm_date(r.get("print_date")),
                 r.get("print_profile_id"), r.get("object_hash"),
                 r.get("session_id"), jsonb(r.get("geometry"))]
                + [metrics.get(c) for c in METRIC_COLS]
                + [r.get("test_end_reason"), r.get("notes") or None,
                   jsonb(r.get("print_profile_snapshot")),
                   jsonb(r.get("source_paths"))])
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Sync reference data (jobs/profiles/sessions/ASTM) into "
                    "Postgres.")
    ap.add_argument("--database-repo", type=Path,
                    default=DATASETS_DIR / "Agentic-SLS-Database")
    ap.add_argument("--astm-repo", type=Path,
                    default=DATASETS_DIR / "Agentic-SLS-ASTM")
    args = ap.parse_args()

    for repo in [args.database_repo, args.astm_repo]:
        if not repo.is_dir():
            print(f"ERROR: repo not found: {repo}", file=sys.stderr)
            return 1

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1

    with psycopg.connect(dsn) as conn:
        conn.execute(DDL)
        conn.execute("TRUNCATE inova_jobs, inova_print_profiles,"
                     " inova_print_sessions, astm_specimens")
        print(f"inova_jobs: {sync_jobs(conn, args.database_repo)} rows")
        print(f"inova_print_profiles: "
              f"{sync_profiles(conn, args.database_repo)} rows")
        print(f"inova_print_sessions: "
              f"{sync_sessions(conn, args.database_repo)} rows")
        print(f"astm_specimens: {sync_specimens(conn, args.astm_repo)} rows")
        conn.execute(BUILDS_MERGED_INTO_DDL)  # ensure column before the view uses it
        conn.execute(REGISTRY_VIEW)
        print("build_registry view refreshed")
        conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
