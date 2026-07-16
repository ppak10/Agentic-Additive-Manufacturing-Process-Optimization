"""Restore pre-wipe build history into Postgres and reconcile numbering.

The DB was reset during refactoring (~2026-07-10) and the recorder restarted
numbering at 1. New-era builds 1,2 are the same prints as exported builds
42,43 (re-imported from spool); 3,4,5 are genuinely new. The flat exports
(data/exports/) are authoritative for builds 1-41.

Steps:
  1. Renumber the new era 5→46 4→45 3→44 2→43 1→42 (descending, so no id
     collisions), re-pointing telemetry/position_hf/frames/events rows and
     rewriting frames.path prefixes. One transaction.
  2. Insert builds 1-41 metadata from builds.jsonl.
  3. COPY frames.jsonl and events.jsonl rows for builds ≤ 41 back into their
     tables (42,43 skipped — already present via the renumber).
     (plotter_commands existed at restore time, empty; table since dropped.)
  4. setval builds_id_seq → 46.
  5. Move July-era frame files out of shared dirs 1-5 into 42-46. Old and new
     eras separate cleanly on the epoch-ms filename prefix (May 31 stubs vs
     July 10+; cutoff 2026-06-20).

Raw telemetry/position ticks for old builds intentionally stay in
data/exports/*.parquet — build summaries are computed from parquet for the
old era; import a build's parquet ad hoc if SQL access is ever needed.

STOP THE RECORDER FIRST and wait for any active print's spool import to
finish. Dry run (default) is read-only and safe anytime.

Usage:
  uv run sls-restore-builds               # dry run: plan + counts
  uv run sls-restore-builds --execute
  uv run sls-restore-builds --files-only  # redo step 5 after a crash
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


# Historical exports relocated 2026-07-16: jsonl now lives in the Telemetry
# dataset's source/recorder/ (this script is one-shot history; path kept
# correct in case of another disaster).
EXPORTS = (Path(__file__).resolve().parent.parent.parent
           / "datasets" / "Agentic-SLS-Telemetry" / "source" / "recorder")
FRAMES_DIR = Path("data/frames")
RENUMBER = [(5, 46), (4, 45), (3, 44), (2, 43), (1, 42)]  # descending!
CHILD_TABLES = ["telemetry", "position_hf", "frames", "events"]
OLD_MAX = 41
NEW_MAX = 46
# Era cutoff for shared frame dirs 1-5: old-era files there are all from
# 2026-05-31; new-era files start 2026-07-10. Epoch ms for 2026-06-20.
ERA_CUTOFF_MS = 1_782_000_000_000


def read_jsonl(path: Path):
    with path.open() as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def check_preconditions(conn) -> None:
    ids = {r[0] for r in conn.execute("SELECT id FROM builds")}
    if ids != {1, 2, 3, 4, 5}:
        sys.exit(f"ABORT: expected builds {{1..5}} in DB, found {sorted(ids)} "
                 "— already restored, or recorder state has moved on. "
                 "Re-check the plan (or use --files-only).")
    for f in ["builds.jsonl", "frames.jsonl", "events.jsonl"]:
        if not (EXPORTS / f).exists():
            sys.exit(f"ABORT: missing {EXPORTS / f}")


def renumber_new_era(conn, execute: bool) -> None:
    print("step 1: renumber new era", RENUMBER)
    for old, new in RENUMBER:
        if not execute:
            continue
        conn.execute(
            "INSERT INTO builds (id, job_name, started_at, ended_at, phase,"
            " params, notes, inova_session_id)"
            " SELECT %s, job_name, started_at, ended_at, phase, params,"
            " notes, inova_session_id FROM builds WHERE id = %s",
            [new, old])
        for t in CHILD_TABLES:
            conn.execute(
                f"UPDATE {t} SET build_id = %s WHERE build_id = %s",
                [new, old])
        conn.execute(
            "UPDATE frames SET path = regexp_replace(path, %s, %s)"
            " WHERE build_id = %s",
            [f"^{old}/", f"{new}/", new])
        conn.execute("DELETE FROM builds WHERE id = %s", [old])
        print(f"  {old} -> {new}")


def insert_old_builds(conn, execute: bool) -> None:
    rows = [r for r in read_jsonl(EXPORTS / "builds.jsonl")
            if r["id"] <= OLD_MAX]
    print(f"step 2: insert {len(rows)} old builds (1-{OLD_MAX}) from "
          "builds.jsonl")
    if not execute:
        return
    for r in rows:
        conn.execute(
            "INSERT INTO builds (id, job_name, started_at, ended_at, phase,"
            " params, notes) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            [r["id"], r.get("job_name"), r["started_at"], r.get("ended_at"),
             r.get("phase"), Jsonb(r["params"]) if r.get("params") else None,
             r.get("notes")])


def copy_old_rows(conn, execute: bool) -> None:
    specs = [
        ("frames", "frames.jsonl", ["build_id", "ts", "kind", "path"]),
        ("events", "events.jsonl",
         ["build_id", "ts", "kind", "message", "payload"]),
    ]
    for table, fname, cols in specs:
        rows = (r for r in read_jsonl(EXPORTS / fname)
                if r.get("build_id") is not None and r["build_id"] <= OLD_MAX)
        if not execute:
            n = sum(1 for _ in rows)
            print(f"step 3: would COPY {n} rows into {table} from {fname}")
            continue
        n = 0
        with conn.cursor() as cur:
            with cur.copy(
                f"COPY {table} ({', '.join(cols)}) FROM STDIN"
            ) as copy:
                for r in rows:
                    vals = [r.get(c) for c in cols]
                    if table == "events" and vals[-1] is not None:
                        vals[-1] = json.dumps(vals[-1])
                    copy.write_row(vals)
                    n += 1
        print(f"step 3: copied {n} rows into {table}")


def fix_sequence(conn, execute: bool) -> None:
    print(f"step 4: setval builds_id_seq -> {NEW_MAX}")
    if execute:
        conn.execute("SELECT setval('builds_id_seq', %s)", [NEW_MAX])


def move_frame_files(execute: bool, frames_dir: Path = FRAMES_DIR) -> None:
    print("step 5: split shared frame dirs by era")
    for old, new in sorted(RENUMBER):
        src = frames_dir / str(old)
        dst = frames_dir / str(new)
        if not src.is_dir():
            continue
        moves = [e for e in os.scandir(src)
                 if int(e.name.split("_")[0]) >= ERA_CUTOFF_MS]
        print(f"  {src} -> {dst}: {len(moves)} new-era files")
        if not execute:
            continue
        dst.mkdir(parents=True, exist_ok=True)
        for e in moves:
            os.rename(e.path, dst / e.name)


def verify(conn) -> None:
    n, lo, hi = conn.execute(
        "SELECT count(*), min(id), max(id) FROM builds").fetchone()
    print(f"verify: {n} builds, ids {lo}..{hi}")
    missing = 0
    for (path,) in conn.execute(
        "SELECT path FROM frames WHERE build_id IN (1, 12, 42, 44, 46)"
        " ORDER BY random() LIMIT 200"
    ):
        if not (FRAMES_DIR / path).exists():
            missing += 1
    print(f"verify: frame path spot-check, {missing}/200 missing")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--execute", action="store_true",
                    help="Apply changes (default is a read-only dry run)")
    ap.add_argument("--files-only", action="store_true",
                    help="Only run step 5 (frame file moves)")
    args = ap.parse_args()

    if args.files_only:
        move_frame_files(args.execute)
        return 0

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1

    if args.execute:
        print("EXECUTING — the recorder must be stopped.\n")

    with psycopg.connect(dsn) as conn:
        check_preconditions(conn)
        renumber_new_era(conn, args.execute)
        insert_old_builds(conn, args.execute)
        copy_old_rows(conn, args.execute)
        fix_sequence(conn, args.execute)
        if args.execute:
            conn.commit()
            print("DB transaction committed.")
    # File moves happen after the DB commit; if interrupted, re-run with
    # --files-only --execute (the era cutoff makes it idempotent).
    move_frame_files(args.execute)

    if args.execute:
        with psycopg.connect(dsn) as conn:
            verify(conn)
    else:
        print("\nDry run only. Stop the recorder, then re-run with --execute.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
