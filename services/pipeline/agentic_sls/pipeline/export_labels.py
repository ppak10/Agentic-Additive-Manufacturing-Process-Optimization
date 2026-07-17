"""Export curated defect labels to the Telemetry dataset, one parquet per
build:

  <dataset>/source/labels/{build_id:03d}.parquet

Labels come from the defect_labels table (the GUI's Telemetry build lab +
live Mission Control verdicts). Only status='active' rows export — the
table is the curation surface, the parquet is the training artifact.

Sync semantics:
  - A build with active labels gets its parquet (re)written every run
    (labels are small; no skip/--force dance).
  - A build whose labels were ALL rejected (or that has a stale file from
    a previous run) gets its parquet REMOVED — curation propagates to the
    dataset. Scrubbing an entire useless build works the same way: reject
    its labels here, and remove its ticks/frames files from the dataset
    repo by hand (build ids are never reused, so the gap is meaningful).
  - Pushing to HF stays a deliberate git commit in the dataset repo — the
    human gate on what the model trains on.

Usage:
  uv run sls-export-labels             # all builds with labels
  uv run sls-export-labels --build 47  # one build only
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg
import pyarrow as pa
import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parent.parent.parent.parent.parent
DATASET = REPO / "datasets" / "Agentic-SLS-Telemetry"
LABELS_DIR = DATASET / "source" / "labels"

COLUMNS = [
    "id", "build_id", "layer", "ts", "frame_ids", "class", "bbox",
    "polarity", "source", "defect_event_id", "note", "created_at", "updated_at",
]

SCHEMA = pa.schema([
    ("id", pa.int64()),
    ("build_id", pa.int64()),
    ("layer", pa.int32()),
    ("ts", pa.timestamp("us", tz="UTC")),
    ("frame_ids", pa.list_(pa.int64())),
    ("class", pa.string()),
    ("bbox", pa.list_(pa.float64())),  # [x0, y0, x1, y1] normalized frame coords
    ("polarity", pa.string()),
    ("source", pa.string()),
    ("defect_event_id", pa.int64()),
    ("note", pa.string()),
    ("created_at", pa.timestamp("us", tz="UTC")),
    ("updated_at", pa.timestamp("us", tz="UTC")),
])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=int, default=None, help="export a single build id")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = parser.parse_args()

    if not args.dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1
    if not DATASET.exists():
        print(f"dataset submodule missing: {DATASET}", file=sys.stderr)
        return 1

    LABELS_DIR.mkdir(parents=True, exist_ok=True)

    where = "status = 'active'"
    params: list[object] = []
    if args.build is not None:
        where += " AND build_id = %s"
        params.append(args.build)

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(COLUMNS)} FROM defect_labels WHERE {where} ORDER BY build_id, id",
            params,
        )
        rows = cur.fetchall()

    by_build: dict[int, list[tuple]] = {}
    for row in rows:
        by_build.setdefault(int(row[1]), []).append(row)

    written = 0
    for build_id, build_rows in sorted(by_build.items()):
        cols = {name: [r[i] for r in build_rows] for i, name in enumerate(COLUMNS)}
        table = pa.Table.from_pydict(cols, schema=SCHEMA)
        out = LABELS_DIR / f"{build_id:03d}.parquet"
        pq.write_table(table, out, compression="zstd")
        print(f"  labels/{out.name}: {len(build_rows)} active labels")
        written += 1

    # prune: parquet exists but the build no longer has active labels (all
    # rejected, or single-build run whose labels vanished) — curation
    # propagates as deletion
    prune_scope = [args.build] if args.build is not None else None
    for f in sorted(LABELS_DIR.glob("*.parquet")):
        try:
            fid = int(f.stem)
        except ValueError:
            continue
        if prune_scope is not None and fid not in prune_scope:
            continue
        if fid not in by_build:
            f.unlink()
            print(f"  labels/{f.name}: removed (no active labels)")

    print(f"done: {written} build(s) exported to {LABELS_DIR.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
