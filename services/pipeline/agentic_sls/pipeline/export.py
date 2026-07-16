"""Flat-file export of the Postgres recorder DB into the Telemetry
dataset's source/ tree (data/exports retired 2026-07-16).

Output layout:
  <dataset>/source/recorder/builds.jsonl
  <dataset>/source/recorder/events.jsonl     (embedding column dropped)
  <dataset>/source/recorder/frames.jsonl     (embedding column dropped)
  <dataset>/source/recorder/sensors.csv      (sidecar; preserves hand-filled
                                              unit/description across runs)
  <dataset>/source/telemetry/{build_id:03d}.parquet
  <dataset>/source/position_hf/{build_id:03d}.parquet
  <Database dataset>/source/build_to_inova_session.csv
                                (sidecar; hand-reviewed linkage — lives beside
                                 the PrintSessions it annotates and publishes
                                 the matching evidence with the dataset)

Idempotent:
  - Existing parquet files are skipped unless --force.
  - Sidecar CSVs are read-merge-written; existing rows preserved, new rows appended.

By default exports only completed builds (ended_at IS NOT NULL).
Pass --include-active to also export the currently-open build (its parquet
will keep changing across runs). An explicit --builds list overrides the
active filter — IDs the user names by hand are always exported.

Usage:
  uv run sls-export
  uv run sls-export --builds 1,2
  uv run sls-export --out /tmp/exports --force
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

import psycopg
import pyarrow as pa
import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parent.parent.parent
from dotenv import load_dotenv


CHUNK_ROWS = 100_000


# ---------- generic helpers ----------

def _json_default(obj):
    if isinstance(obj, datetime):
        if obj.tzinfo is None:
            obj = obj.replace(tzinfo=timezone.utc)
        return obj.astimezone(timezone.utc).isoformat()
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    raise TypeError(f"unhandled type for JSON: {type(obj)}")


def _write_jsonl(rows: Iterable[dict], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w") as f:
        for row in rows:
            f.write(json.dumps(row, default=_json_default))
            f.write("\n")
            n += 1
    return n


def _rows_as_dicts(cur) -> Iterator[dict]:
    cols = [d.name for d in cur.description]
    for row in cur:
        yield dict(zip(cols, row))


def _table_exists(conn, name: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", [name])
        return cur.fetchone()[0]


def _maybe_where_build(sql: str, args: list, build_ids: list[int] | None,
                       col: str = "build_id") -> tuple[str, list]:
    if build_ids:
        sql += f" WHERE {col} = ANY(%s)"
        args = args + [build_ids]
    return sql, args


# ---------- JSONL table exports ----------

def export_builds(conn, out: Path, build_ids: list[int] | None) -> int:
    sql, args = _maybe_where_build(
        "SELECT id, job_name, started_at, ended_at, phase, params, notes FROM builds",
        [], build_ids, col="id",
    )
    sql += " ORDER BY id"
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return _write_jsonl(_rows_as_dicts(cur), out / "builds.jsonl")


def export_events(conn, out: Path, build_ids: list[int] | None) -> int:
    sql, args = _maybe_where_build(
        "SELECT id, build_id, ts, kind, message, payload FROM events",
        [], build_ids,
    )
    sql += " ORDER BY id"
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return _write_jsonl(_rows_as_dicts(cur), out / "events.jsonl")


def export_frames(conn, out: Path, build_ids: list[int] | None) -> int:
    sql, args = _maybe_where_build(
        "SELECT id, build_id, ts, kind, path FROM frames",
        [], build_ids,
    )
    sql += " ORDER BY build_id, ts"
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return _write_jsonl(_rows_as_dicts(cur), out / "frames.jsonl")


# ---------- parquet per-build exports ----------

TELEMETRY_SCHEMA = pa.schema([
    pa.field("ts", pa.timestamp("us", tz="UTC")),
    pa.field("sensor_id", pa.string()),
    pa.field("kind", pa.string()),
    pa.field("value", pa.float64()),
])

POSITION_HF_SCHEMA = pa.schema([
    pa.field("ts", pa.timestamp("us", tz="UTC")),
    pa.field("x", pa.float64()),
    pa.field("y", pa.float64()),
    pa.field("z1", pa.float64()),
    pa.field("z2", pa.float64()),
    pa.field("r", pa.float64()),
    pa.field("has_homed", pa.bool_()),
])


def _write_parquet_chunked(
    conn,
    sql: str,
    args: list,
    out_path: Path,
    schema: pa.Schema,
    chunk_rows: int = CHUNK_ROWS,
) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    n = 0
    writer: pq.ParquetWriter | None = None
    try:
        # Server-side cursor: streams rows without loading them all into memory.
        with conn.cursor(name=f"export_{out_path.stem}") as cur:
            cur.execute(sql, args)
            cols = [d.name for d in cur.description]
            while True:
                rows = cur.fetchmany(chunk_rows)
                if not rows:
                    break
                # Build column-oriented dict for pyarrow (faster than from_pylist).
                columns: dict[str, list] = {c: [] for c in cols}
                for r in rows:
                    for i, c in enumerate(cols):
                        columns[c].append(r[i])
                table = pa.Table.from_pydict(columns, schema=schema)
                if writer is None:
                    writer = pq.ParquetWriter(tmp_path, schema, compression="zstd")
                writer.write_table(table)
                n += len(rows)
        if writer is not None:
            writer.close()
            tmp_path.replace(out_path)
        return n
    except BaseException:
        if writer is not None:
            writer.close()
        if tmp_path.exists():
            tmp_path.unlink()
        raise


def export_telemetry_for_build(conn, out: Path, build_id: int, force: bool) -> int:
    p = out / "telemetry" / f"{build_id:03d}.parquet"
    if p.exists() and not force:
        return -1
    return _write_parquet_chunked(
        conn,
        "SELECT ts, sensor_id, kind, value FROM telemetry "
        "WHERE build_id = %s ORDER BY ts",
        [build_id],
        p,
        TELEMETRY_SCHEMA,
    )


def export_position_hf_for_build(conn, out: Path, build_id: int, force: bool) -> int:
    p = out / "position_hf" / f"{build_id:03d}.parquet"
    if p.exists() and not force:
        return -1
    return _write_parquet_chunked(
        conn,
        "SELECT ts, x, y, z1, z2, r, has_homed FROM position_hf "
        "WHERE build_id = %s ORDER BY ts",
        [build_id],
        p,
        POSITION_HF_SCHEMA,
    )


# ---------- sidecar CSVs ----------

def _read_csv_dicts(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def _write_csv(rows: list[dict], path: Path, columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in columns})


def update_build_session_csv(conn, out: Path) -> int:
    """Always enumerates ALL builds, regardless of --builds filter.

    The sidecar is the canonical list the user fills in by hand. Scoping
    it to --builds would re-prompt them with new empty rows on every full
    run. Hand-filled UUIDs and notes are preserved across re-runs.
    """
    path = out / "build_to_inova_session.csv"
    cols = ["build_id", "inova_session_id", "notes"]
    existing = _read_csv_dicts(path)
    have = {row["build_id"] for row in existing}

    with conn.cursor() as cur:
        cur.execute("SELECT id FROM builds ORDER BY id")
        for (bid,) in cur:
            if str(bid) not in have:
                existing.append(
                    {"build_id": str(bid), "inova_session_id": "", "notes": ""}
                )
                have.add(str(bid))

    _write_csv(existing, path, cols)
    return len(existing)


def update_sensors_csv(out: Path, observed: set[tuple[str, str]]) -> int:
    path = out / "sensors.csv"
    cols = ["sensor_id", "kind", "unit", "description"]
    existing = _read_csv_dicts(path)
    have = {(row["sensor_id"], row["kind"]) for row in existing}
    for pair in sorted(observed - have):
        existing.append(
            {"sensor_id": pair[0], "kind": pair[1], "unit": "", "description": ""}
        )
    _write_csv(existing, path, cols)
    return len(existing)


def collect_sensor_pairs(conn) -> set[tuple[str, str]]:
    """DB-wide DISTINCT, regardless of --builds filter.

    sensors.csv is the canonical units glossary the user fills in by hand;
    scoping it to --builds would re-prompt them with new empty rows on every
    full run. Hand-filled unit/description are preserved across re-runs.

    On a 100M-row telemetry table this is a HashAggregate over a seq scan —
    minutes once, then negligible because the result set is tiny (~tens of
    sensors). If this gets unbearable, switch to per-build looped DISTINCT.
    """
    out: set[tuple[str, str]] = set()
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT sensor_id, kind FROM telemetry")
        for s, k in cur:
            out.add((s, k))
    return out


# ---------- driver ----------

def get_target_builds(
    conn,
    explicit_build_ids: list[int] | None,
    include_active: bool,
) -> list[int]:
    sql, args = _maybe_where_build(
        "SELECT id, ended_at FROM builds", [], explicit_build_ids, col="id",
    )
    sql += " ORDER BY id"
    with conn.cursor() as cur:
        cur.execute(sql, args)
        rows = cur.fetchall()
    # Explicit list wins: if the user named IDs, honor them as-is.
    if explicit_build_ids or include_active:
        return [r[0] for r in rows]
    return [r[0] for r in rows if r[1] is not None]


def parse_build_ids(s: str | None) -> list[int] | None:
    if not s:
        return None
    return [int(x.strip()) for x in s.split(",") if x.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Export Postgres recorder DB to flat files.",
    )
    ap.add_argument("--builds", type=str, default=None,
                    help="Comma-separated build IDs (default: all completed)")
    ap.add_argument("--dataset", type=Path,
                    default=REPO / "datasets" / "Agentic-SLS-Telemetry",
                    help="Telemetry dataset checkout (jsonl+parquet land in its source/)")
    ap.add_argument("--mappings-dir", type=Path,
                    default=REPO / "datasets" / "Agentic-SLS-Database" / "source",
                    help="Output directory (default: data/exports)")
    ap.add_argument("--include-active", action="store_true",
                    help="Include the currently-open build (ended_at IS NULL)")
    ap.add_argument("--force", action="store_true",
                    help="Overwrite existing parquet files")
    args = ap.parse_args()

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1

    explicit = parse_build_ids(args.builds)
    dataset: Path = args.dataset
    if not (dataset / ".git").exists():
        print(f"ERROR: dataset checkout missing at {dataset} — refusing "
              "(init the submodule; export never writes outside it)",
              file=sys.stderr)
        return 1
    source = dataset / "source"
    recorder = source / "recorder"
    recorder.mkdir(parents=True, exist_ok=True)
    args.mappings_dir.mkdir(parents=True, exist_ok=True)

    with psycopg.connect(dsn) as conn:
        targets = get_target_builds(conn, explicit, args.include_active)
        print(f"export: {len(targets)} builds → {source}")

        n = export_builds(conn, recorder, explicit)
        print(f"  recorder/builds.jsonl: {n} rows")
        n = export_events(conn, recorder, explicit)
        print(f"  recorder/events.jsonl: {n} rows")
        n = export_frames(conn, recorder, explicit)
        print(f"  recorder/frames.jsonl: {n} rows")

        for bid in targets:
            n = export_telemetry_for_build(conn, source, bid, args.force)
            tag = "skipped" if n < 0 else f"{n} rows"
            print(f"  telemetry/{bid:03d}.parquet: {tag}")
            n = export_position_hf_for_build(conn, source, bid, args.force)
            tag = "skipped" if n < 0 else f"{n} rows"
            print(f"  position_hf/{bid:03d}.parquet: {tag}")

        observed = collect_sensor_pairs(conn)
        n = update_build_session_csv(conn, args.mappings_dir)
        print(f"  Database/source/build_to_inova_session.csv: {n} rows (all builds)")
        n = update_sensors_csv(recorder, observed)
        print(f"  recorder/sensors.csv: {n} rows (all sensors)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
