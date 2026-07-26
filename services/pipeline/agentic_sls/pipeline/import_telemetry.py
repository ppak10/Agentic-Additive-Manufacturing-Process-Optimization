"""Import old-era telemetry from the dataset parquet back into Postgres.

Pre-2026-07-13-restore builds were deliberately kept OUT of the `telemetry`
table (big + slow; they live in the dataset parquet). This reverses that for
builds you want queryable / triageable — `sls-analyze-build` reads
`position.z2` from Postgres, so an old build needs its telemetry back in the DB
before it can be triaged.

Source: `<dataset>/source/telemetry/{build:03d}.parquet` (columns
`ts, sensor_id, kind, value`; `build_id` is implied by the filename). Loaded
via server-side COPY, one transaction per build (a mid-run failure keeps the
builds that already landed).

By default imports every build with a source parquet that is NOT already in the
telemetry table (fills 1-41 without touching 42-48). `--force` re-imports a
build (deletes its existing rows first).

Usage:
  uv run sls-import-telemetry                  # all builds missing from the DB
  uv run sls-import-telemetry --builds 1,2,26
  uv run sls-import-telemetry --builds 26 --force
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg
import pyarrow.parquet as pq
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[4]
DEFAULT_DATASET = REPO / "datasets" / "Agentic-SLS-Telemetry"
BATCH_ROWS = 100_000


def build_has_rows(conn: psycopg.Connection, build_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM telemetry WHERE build_id = %s LIMIT 1", (build_id,))
        return cur.fetchone() is not None


def import_build(conn: psycopg.Connection, build_id: int, path: Path, force: bool) -> int:
    """Returns rows imported, or -1 if skipped (already present, no --force)."""
    if build_has_rows(conn, build_id):
        if not force:
            return -1
        with conn.cursor() as cur:
            cur.execute("DELETE FROM telemetry WHERE build_id = %s", (build_id,))

    pf = pq.ParquetFile(path)
    n = 0
    with conn.cursor() as cur:
        with cur.copy(
            "COPY telemetry (build_id, ts, sensor_id, kind, value) FROM STDIN"
        ) as copy:
            for batch in pf.iter_batches(
                batch_size=BATCH_ROWS, columns=["ts", "sensor_id", "kind", "value"]
            ):
                d = batch.to_pydict()
                for ts, sid, kind, val in zip(
                    d["ts"], d["sensor_id"], d["kind"], d["value"]
                ):
                    copy.write_row((build_id, ts, sid, kind, val))
                    n += 1
    conn.commit()
    return n


def parse_builds(s: str | None) -> list[int] | None:
    if not s:
        return None
    return [int(x.strip()) for x in s.split(",") if x.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description="Import dataset telemetry parquet into Postgres.")
    ap.add_argument("--builds", type=str, default=None,
                    help="Comma-separated build ids (default: all parquets not already in the DB)")
    ap.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    ap.add_argument("--force", action="store_true",
                    help="re-import even if the build already has telemetry rows (deletes first)")
    ap.add_argument("--dsn", default=None)
    args = ap.parse_args()

    load_dotenv()
    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set", file=sys.stderr)
        return 1

    tel_dir = args.dataset / "source" / "telemetry"
    if not tel_dir.is_dir():
        print(f"ERROR: {tel_dir} not found", file=sys.stderr)
        return 1

    explicit = parse_builds(args.builds)
    if explicit is not None:
        targets = [(b, tel_dir / f"{b:03d}.parquet") for b in explicit]
    else:
        targets = [(int(p.stem), p) for p in sorted(tel_dir.glob("*.parquet"))]

    imported = skipped = missing = 0
    with psycopg.connect(dsn) as conn:
        for build_id, path in targets:
            if not path.exists():
                print(f"  build {build_id}: no parquet at {path} — skipped")
                missing += 1
                continue
            n = import_build(conn, build_id, path, args.force)
            if n < 0:
                print(f"  build {build_id}: already in DB — skipped (use --force to replace)")
                skipped += 1
            else:
                print(f"  build {build_id}: imported {n:,} rows")
                imported += 1
    print(f"done: {imported} imported, {skipped} skipped, {missing} missing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
