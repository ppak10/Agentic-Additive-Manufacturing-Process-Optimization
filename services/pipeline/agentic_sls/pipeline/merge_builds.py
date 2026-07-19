"""Merge recorder builds that are really one print (restart split).

One firmware PrintSession can span multiple recorder builds: if the recorder
is stopped/restarted mid-print it mints a fresh integer build id, leaving two
build rows that share one inova_session_id (the first often missing job_name /
telemetry — the "stale" one). This folds the loser build(s) into a canonical
winner WITHOUT deleting anything, so any lingering reference to a loser id
still resolves.

What "merge" does, in one transaction:
  1. Repoint every build-keyed child row (telemetry, frames, position_hf,
     events, build_summaries, defect_labels, anomaly_candidates, agent_*,
     conversation_builds — discovered dynamically) from loser -> winner.
  2. Extend the winner's [started_at, ended_at] to cover the losers' span.
  3. Tombstone each loser: builds.merged_into = winner (the row stays, so
     references resolve; the build_registry view hides merged rows).

Deleting instead would be unsafe: only telemetry/frames/position_hf/events
have ON DELETE CASCADE FKs — build_summaries/defect_labels/anomaly_candidates
reference build_id with no FK and would be silently orphaned.

Dry-run by default (prints the row counts it would move); --apply commits.
After --apply, recompute the winner's rollup:
    uv run sls-summarize-builds --build <winner>

Usage:
  uv run sls-merge-builds --into 46 --from 45
  uv run sls-merge-builds --into 46 --from 45 --apply
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import psycopg
from dotenv import load_dotenv

# build_registry view DDL + the merged_into column DDL live with the rest of
# the reference-schema definitions; reuse them so the view stays in sync.
from agentic_sls.pipeline.sync_reference import BUILDS_MERGED_INTO_DDL, REGISTRY_VIEW


def build_id_tables(conn) -> list[str]:
    """Every base table (not view, not builds itself) with a build_id column."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT c.table_name "
            "FROM information_schema.columns c "
            "JOIN information_schema.tables t "
            "  ON t.table_name = c.table_name AND t.table_schema = c.table_schema "
            "WHERE c.column_name = 'build_id' "
            "  AND c.table_schema = 'public' "
            "  AND t.table_type = 'BASE TABLE' "
            "  AND c.table_name <> 'builds' "
            "ORDER BY c.table_name"
        )
        return [r[0] for r in cur]


def load_build(conn, bid: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, started_at, ended_at, inova_session_id, job_name, merged_into "
            "FROM builds WHERE id = %s",
            [bid],
        )
        r = cur.fetchone()
    if not r:
        return None
    return {
        "id": r[0], "started_at": r[1], "ended_at": r[2],
        "inova_session_id": r[3], "job_name": r[4], "merged_into": r[5],
    }


def count_rows(conn, tables: list[str], bid: int) -> dict[str, int]:
    counts = {}
    with conn.cursor() as cur:
        for t in tables:
            cur.execute(f"SELECT count(*) FROM {t} WHERE build_id = %s", [bid])
            counts[t] = cur.fetchone()[0]
    return counts


def recreate_registry_view(conn) -> None:
    """Rebuild the view so merged rows drop out. The exclusive lock can deadlock
    against a concurrent /api/registry reader — same as sls-sync-reference — so
    retry a few times (the poll window is short)."""
    for attempt in range(1, 6):
        try:
            conn.execute("SET lock_timeout = '5s'")
            conn.execute(REGISTRY_VIEW)
            conn.execute("RESET lock_timeout")
            return
        except (psycopg.errors.DeadlockDetected, psycopg.errors.LockNotAvailable):
            conn.rollback()
            if attempt == 5:
                raise
            time.sleep(2)


def merge(conn, winner: int, losers: list[int], force: bool, apply: bool) -> int:
    # Ensure the tombstone column exists so the reads below work on a DB that
    # predates it. Idempotent; on a dry run it rolls back with the txn.
    conn.execute(BUILDS_MERGED_INTO_DDL)

    w = load_build(conn, winner)
    if not w:
        print(f"ERROR: winner build {winner} not found", file=sys.stderr)
        return 1
    if w["merged_into"] is not None:
        print(f"ERROR: winner {winner} is itself merged into "
              f"{w['merged_into']}", file=sys.stderr)
        return 1

    loser_rows = []
    for lid in losers:
        if lid == winner:
            print(f"ERROR: --from {lid} equals --into", file=sys.stderr)
            return 1
        lb = load_build(conn, lid)
        if not lb:
            print(f"ERROR: loser build {lid} not found", file=sys.stderr)
            return 1
        if lb["merged_into"] is not None:
            print(f"ERROR: loser {lid} already merged into "
                  f"{lb['merged_into']}", file=sys.stderr)
            return 1
        # Safety: only fold builds that share the winner's firmware session —
        # that's what makes them the same physical print. --force overrides.
        if lb["inova_session_id"] != w["inova_session_id"]:
            msg = (f"loser {lid} session {lb['inova_session_id']} != winner "
                   f"session {w['inova_session_id']}")
            if not force:
                print(f"ERROR: {msg} (use --force to merge anyway)",
                      file=sys.stderr)
                return 1
            print(f"WARNING: {msg} — proceeding (--force)")
        loser_rows.append(lb)

    tables = build_id_tables(conn)

    print(f"winner : build {winner}  '{w['job_name'] or '(no job_name)'}'  "
          f"session {str(w['inova_session_id'])[:8]}")
    print(f"         window {w['started_at']} .. {w['ended_at']}")
    new_start = w["started_at"]
    new_end = w["ended_at"]
    total = {t: 0 for t in tables}
    for lb in loser_rows:
        counts = count_rows(conn, tables, lb["id"])
        moved = {t: n for t, n in counts.items() if n}
        print(f"\nloser  : build {lb['id']}  '{lb['job_name'] or '(no job_name)'}'  "
              f"window {lb['started_at']} .. {lb['ended_at']}")
        print("         rows to move: "
              + (", ".join(f"{t}={n}" for t, n in moved.items()) or "(none)"))
        for t, n in counts.items():
            total[t] += n
        if lb["started_at"] and (new_start is None or lb["started_at"] < new_start):
            new_start = lb["started_at"]
        if lb["ended_at"] and (new_end is None or lb["ended_at"] > new_end):
            new_end = lb["ended_at"]

    print(f"\nwinner {winner} new window -> {new_start} .. {new_end}")
    grand = {t: n for t, n in total.items() if n}
    print("total rows to move: "
          + (", ".join(f"{t}={n}" for t, n in grand.items()) or "(none)"))

    if not apply:
        print("\nDRY RUN — re-run with --apply to commit. "
              f"Then: uv run sls-summarize-builds --build {winner}")
        return 0

    # ---- one transaction: move rows, extend the winner, tombstone the losers
    with conn.cursor() as cur:
        for lb in loser_rows:
            for t in tables:
                cur.execute(
                    f"UPDATE {t} SET build_id = %s WHERE build_id = %s",
                    [winner, lb["id"]],
                )
        cur.execute(
            "UPDATE builds SET started_at = %s, ended_at = %s WHERE id = %s",
            [new_start, new_end, winner],
        )
        for lb in loser_rows:
            cur.execute(
                "UPDATE builds SET merged_into = %s WHERE id = %s",
                [winner, lb["id"]],
            )
    conn.commit()

    # Rebuild the registry view so the tombstoned losers drop out of the table.
    recreate_registry_view(conn)
    conn.commit()

    print(f"\nmerged {', '.join(str(l['id']) for l in loser_rows)} -> {winner}")
    print(f"next:  uv run sls-summarize-builds --build {winner}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fold recorder builds split by a restart into one canonical build.",
    )
    ap.add_argument("--into", type=int, required=True,
                    help="Canonical winner build id (survives)")
    ap.add_argument("--from", dest="losers", type=int, nargs="+", required=True,
                    help="Loser build id(s) to fold into the winner")
    ap.add_argument("--apply", action="store_true",
                    help="Commit the merge (default is a dry run)")
    ap.add_argument("--force", action="store_true",
                    help="Merge even if the builds don't share an inova_session_id")
    args = ap.parse_args()

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1

    with psycopg.connect(dsn) as conn:
        return merge(conn, args.into, args.losers, args.force, args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
