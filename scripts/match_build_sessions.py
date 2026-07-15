"""Match recorder builds to Inova firmware PrintSessions by time overlap.

The recorder mints integer build ids; the firmware records each print as a
PrintSession JSON (UUID id, StartTime/CompleteTime, JobId, ProfileId). Nothing
links the two at record time for historical builds — this script proposes the
mapping so a human can review it, then applies it.

Two modes:
  propose (default)  Match builds to sessions by interval overlap and write
                     candidates into data/exports/build_to_inova_session.csv.
                     Hand-filled (non-"auto:") rows are never touched; auto
                     rows are refreshed. Evidence goes in the notes column.
  --apply            Read the CSV and write non-empty session UUIDs into
                     builds.inova_session_id. Review the CSV first.

Usage:
  uv run scripts/match_build_sessions.py
  uv run scripts/match_build_sessions.py --apply
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from dotenv import load_dotenv


DEFAULT_SESSIONS_DIR = (
    Path(__file__).resolve().parent.parent
    / "datasets/Inova-Mk1-Database/source/PrintSessions"
)
CSV_COLS = ["build_id", "inova_session_id", "notes"]

# Recorder start can lag/lead the firmware session start (heating phase,
# recorder restarts), so intervals are padded before overlap is computed.
SLACK = timedelta(minutes=15)

# Firmware PrintSession.Result codes (observed: 0 also pairs with null
# CompleteTime, i.e. the session never finished cleanly).
RESULT_LABELS = {0: "incomplete", 1: "completed", 2: "cancelled"}


@dataclass
class Session:
    id: str
    start: datetime
    end: datetime | None
    job_name: str | None
    job_id: str | None
    profile_name: str | None
    result: int | None

    @property
    def result_label(self) -> str:
        return RESULT_LABELS.get(self.result, f"result={self.result}")


def load_sessions(sessions_dir: Path) -> list[Session]:
    sessions = []
    for path in sorted(sessions_dir.glob("*.json")):
        d = json.loads(path.read_text())
        end = d.get("CompleteTime")
        sessions.append(Session(
            id=d["Id"],
            start=datetime.fromisoformat(d["StartTime"]),
            end=datetime.fromisoformat(end) if end else None,
            job_name=d.get("JobName"),
            job_id=d.get("JobId"),
            profile_name=d.get("ProfileName"),
            result=d.get("Result"),
        ))
    return sessions


def load_builds(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, job_name, started_at, ended_at FROM builds ORDER BY id"
        )
        return [
            {"id": r[0], "job_name": r[1], "started_at": r[2], "ended_at": r[3]}
            for r in cur
        ]


def load_builds_jsonl(path: Path) -> list[dict]:
    """Exported builds.jsonl as the build source — needed while Postgres holds
    only the post-wipe era; the export is the authoritative historical list."""
    builds = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        builds.append({
            "id": r["id"],
            "job_name": r.get("job_name"),
            "started_at": datetime.fromisoformat(r["started_at"]),
            "ended_at": (datetime.fromisoformat(r["ended_at"])
                         if r.get("ended_at") else None),
        })
    return builds


def overlap_seconds(a0: datetime, a1: datetime,
                    b0: datetime, b1: datetime) -> float:
    return (min(a1, b1) - max(a0, b0)).total_seconds()


def score(build: dict, s: Session) -> tuple[float, float] | None:
    """(overlap_s, -|Δstart|) for ranking, or None if disjoint.

    A session with no CompleteTime is treated as a point-ish interval one
    minute long — it still overlaps builds that begin near its start.
    """
    b0 = build["started_at"] - SLACK
    b1 = (build["ended_at"] or build["started_at"]) + SLACK
    s0, s1 = s.start, s.end or (s.start + timedelta(minutes=1))
    ov = overlap_seconds(b0, b1, s0, s1)
    if ov <= 0:
        return None
    dstart = abs((s.start - build["started_at"]).total_seconds())
    return (ov, -dstart)


def match(builds: list[dict], sessions: list[Session]) -> dict[int, dict]:
    """build_id -> {session, note} for every build with at least one candidate."""
    out: dict[int, dict] = {}
    for b in builds:
        ranked = sorted(
            ((sc, s) for s in sessions if (sc := score(b, s)) is not None),
            key=lambda t: t[0], reverse=True,
        )
        if not ranked:
            continue
        (ov, ndstart), best = ranked[0]
        note = (
            f"auto: Δstart={int(-ndstart)}s overlap={int(ov / 60)}min "
            f"job='{best.job_name}' {best.result_label}"
        )
        if len(ranked) > 1:
            note += f" AMBIGUOUS(+{len(ranked) - 1}: "
            note += ", ".join(s.id[:8] for _, s in ranked[1:4]) + ")"
        out[b["id"]] = {"session": best, "note": note}
    return out


# ---------- CSV (same read-merge-write contract as export.py sidecars) ----------

def read_csv_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def write_csv_rows(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in CSV_COLS})


def propose(builds: list[dict], csv_path: Path, sessions_dir: Path) -> int:
    sessions = load_sessions(sessions_dir)
    matches = match(builds, sessions)

    rows = {r["build_id"]: r for r in read_csv_rows(csv_path)}
    filled = 0
    for b in builds:
        bid = str(b["id"])
        row = rows.setdefault(
            bid, {"build_id": bid, "inova_session_id": "", "notes": ""}
        )
        hand_filled = row["inova_session_id"] and not row["notes"].startswith("auto:")
        if hand_filled:
            continue
        m = matches.get(b["id"])
        if m:
            row["inova_session_id"] = m["session"].id
            row["notes"] = m["note"]
            filled += 1
        elif not row["inova_session_id"]:
            row["notes"] = "auto: no overlapping session"

    ordered = sorted(rows.values(), key=lambda r: int(r["build_id"]))
    write_csv_rows(ordered, csv_path)

    print(f"{len(builds)} builds, {len(sessions)} sessions, "
          f"{filled} candidates written to {csv_path}\n")
    for r in ordered:
        sid = r["inova_session_id"][:8] if r["inova_session_id"] else "-" * 8
        print(f"  build {r['build_id']:>3}  {sid}  {r['notes']}")
    print("\nReview the CSV (fix AMBIGUOUS rows, blank out bad matches), "
          "then run with --apply.")
    return 0


def apply(conn, csv_path: Path) -> int:
    rows = [r for r in read_csv_rows(csv_path) if r["inova_session_id"]]
    if not rows:
        print("ERROR: no filled inova_session_id rows in CSV", file=sys.stderr)
        return 1
    for r in rows:
        uuid.UUID(r["inova_session_id"])  # fail loudly on typos before writing
    with conn.cursor() as cur:
        for r in rows:
            cur.execute(
                "UPDATE builds SET inova_session_id = %s WHERE id = %s",
                [r["inova_session_id"], int(r["build_id"])],
            )
    conn.commit()
    print(f"applied {len(rows)} session UUIDs to builds.inova_session_id")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Match recorder builds to firmware PrintSessions.",
    )
    ap.add_argument("--apply", action="store_true",
                    help="Write reviewed CSV UUIDs into builds.inova_session_id")
    ap.add_argument("--csv", type=Path,
                    default=Path("data/exports/build_to_inova_session.csv"))
    ap.add_argument("--sessions-dir", type=Path, default=DEFAULT_SESSIONS_DIR,
                    help="Inova-Mk1-Database PrintSessions directory")
    ap.add_argument("--builds-jsonl", type=Path, default=None,
                    help="Read builds from an exported builds.jsonl instead of "
                         "Postgres (no DB connection needed)")
    args = ap.parse_args()

    if not args.apply:
        if not args.sessions_dir.is_dir():
            print(f"ERROR: sessions dir not found: {args.sessions_dir}",
                  file=sys.stderr)
            return 1
        if args.builds_jsonl:
            return propose(load_builds_jsonl(args.builds_jsonl),
                           args.csv, args.sessions_dir)

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1

    with psycopg.connect(dsn) as conn:
        if args.apply:
            return apply(conn, args.csv)
        return propose(load_builds(conn), args.csv, args.sessions_dir)


if __name__ == "__main__":
    raise SystemExit(main())
