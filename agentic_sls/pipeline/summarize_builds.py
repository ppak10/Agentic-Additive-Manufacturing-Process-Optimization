"""Compute per-build telemetry summaries for agent consumption.

Agents can't read raw 10 Hz ticks; this derives the compact features they
query instead (via the future telemetry_summary MCP tool): recoat/layer
timeline, laser duty, power draw, and per-sensor thermal tracking error.
Results land in the build_summaries table, keyed by build_id.

Sources:
  - data/exports/telemetry/{build_id}.parquet (skinny ts/sensor_id/kind/value)
    — the only home of pre-wipe raw ticks (old era stays out of Postgres).
  - Postgres telemetry table — for new-era builds. Only use AFTER the
    restore has reconciled build numbering (restore_builds.py).

Layer detection: position.z2 is the layer platform height; each upward step
of 30-1000 µm is one recoat. Recoats where the laser fired are print layers
(bed-preparation recoats have no laser activity).

build_summaries has no FK to builds on purpose: summaries for old-era builds
are computed from parquet before the restore backfills their builds rows.

Usage:
  uv run sls-summarize-builds                 # all parquet exports
  uv run sls-summarize-builds --builds 12,26
  uv run sls-summarize-builds --builds 44 --source postgres
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import polars as pl
import psycopg
from psycopg.types.json import Jsonb
from dotenv import load_dotenv


PARQUET_DIR = Path("data/exports/telemetry")

DDL = """
CREATE TABLE IF NOT EXISTS build_summaries (
  build_id      BIGINT PRIMARY KEY,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL,
  duration_s    DOUBLE PRECISION,
  n_recoats     INT,
  n_print_layers INT,
  layer_duration_s_median DOUBLE PRECISION,
  laser_on_s    DOUBLE PRECISION,
  power_w_mean  DOUBLE PRECISION,
  power_w_max   DOUBLE PRECISION,
  temps         JSONB,
  layers        JSONB
);
"""

LASER_ON_W = 0.0          # laser "power" is a 0/1 enable state; any >0 = firing
Z2_STEP_UM = (30, 1000)   # one recoat = upward z2 step in this range


def load_ticks(build_id: int, source: str, conn) -> pl.DataFrame | None:
    if source == "parquet":
        path = PARQUET_DIR / f"{build_id}.parquet"
        if not path.exists():
            return None
        return pl.read_parquet(path)
    q = ("SELECT ts, sensor_id, kind, value FROM telemetry"
         " WHERE build_id = %s ORDER BY ts")
    rows = conn.execute(q, [build_id]).fetchall()
    if not rows:
        return None
    return pl.DataFrame(rows, schema=["ts", "sensor_id", "kind", "value"],
                        orient="row")


def summarize(df: pl.DataFrame) -> dict | None:
    df = df.sort("ts")
    t0, t1 = df["ts"].min(), df["ts"].max()
    duration_s = (t1 - t0).total_seconds()
    if duration_s <= 0:
        return None
    off = (pl.col("ts") - t0).dt.total_seconds().alias("t")

    # --- recoat boundaries from z2 steps ---
    z2 = (df.filter((pl.col("sensor_id") == "positions")
                    & (pl.col("kind") == "position.z2"))
            .with_columns(off).select("t", "value"))
    steps = (z2.with_columns(pl.col("value").diff().alias("d"))
               .filter((pl.col("d") >= Z2_STEP_UM[0])
                       & (pl.col("d") <= Z2_STEP_UM[1])))
    starts = steps["t"].to_list()

    # --- laser duty ---
    laser = (df.filter((pl.col("sensor_id") == "laser")
                       & (pl.col("kind") == "power"))
               .with_columns(off).select("t", "value").sort("t"))
    lt = laser["t"].to_list()
    lv = laser["value"].to_list()
    # integrate on-time as sum of sample gaps while power is high
    laser_on_s = 0.0
    on_by_layer: list[float] = [0.0] * (len(starts) + 1)
    import bisect
    for i in range(1, len(lt)):
        if lv[i - 1] is not None and lv[i - 1] > LASER_ON_W:
            dt = lt[i] - lt[i - 1]
            laser_on_s += dt
            on_by_layer[bisect.bisect_right(starts, lt[i - 1])] += dt

    # --- per-recoat windows ---
    bed = (df.filter((pl.col("sensor_id") == "printBed")
                     & (pl.col("kind") == "temp.current"))
             .with_columns(off).select("t", "value").sort("t"))
    bt, bv = bed["t"].to_list(), bed["value"].to_list()
    layers = []
    bounds = starts + [duration_s]
    for i in range(len(starts)):
        w0, w1 = bounds[i], bounds[i + 1]
        j0 = bisect.bisect_left(bt, w0)
        j1 = bisect.bisect_left(bt, w1)
        vals = [v for v in bv[j0:j1] if v is not None]
        layers.append({
            "recoat": i + 1,
            "t_s": round(w0, 1),
            "duration_s": round(w1 - w0, 1),
            "laser_on_s": round(on_by_layer[i + 1], 1),
            "print_bed_c": round(sum(vals) / len(vals), 2) if vals else None,
        })
    print_layers = [l for l in layers if l["laser_on_s"] > 0]
    pl_durations = sorted(l["duration_s"] for l in print_layers)
    median = (pl_durations[len(pl_durations) // 2]
              if pl_durations else None)

    # --- power draw ---
    power = df.filter((pl.col("sensor_id") == "powerman")
                      & (pl.col("kind") == "power.current"))["value"]
    power_mean = power.mean()
    power_max = power.max()

    # --- thermal tracking error per temp sensor (where a target is set) ---
    temps = {}
    tdf = (df.filter(pl.col("kind").is_in(["temp.current", "temp.target"]))
             .pivot(on="kind", index=["ts", "sensor_id"], values="value",
                    aggregate_function="mean"))
    # A stream missing either kind (aborted stubs) pivots without the column.
    if {"temp.current", "temp.target"} <= set(tdf.columns):
        tdf = (tdf.filter(pl.col("temp.target") > 0)
                  .with_columns((pl.col("temp.current")
                                 - pl.col("temp.target")).alias("dev")))
        for (sensor,), g in tdf.group_by("sensor_id"):
            temps[sensor] = {
                "dev_mean": round(g["dev"].mean(), 3),
                "dev_std": round(g["dev"].std() or 0, 3),
                "current_max": round(g["temp.current"].max(), 2),
            }

    return {
        "duration_s": duration_s,
        "n_recoats": len(starts),
        "n_print_layers": len(print_layers),
        "layer_duration_s_median": median,
        "laser_on_s": round(laser_on_s, 1),
        "power_w_mean": power_mean,
        "power_w_max": power_max,
        "temps": temps,
        "layers": layers,
    }


def upsert(conn, build_id: int, source: str, s: dict) -> None:
    conn.execute(
        "INSERT INTO build_summaries (build_id, source, duration_s,"
        " n_recoats, n_print_layers, layer_duration_s_median, laser_on_s,"
        " power_w_mean, power_w_max, temps, layers)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (build_id) DO UPDATE SET"
        " computed_at = now(), source = EXCLUDED.source,"
        " duration_s = EXCLUDED.duration_s,"
        " n_recoats = EXCLUDED.n_recoats,"
        " n_print_layers = EXCLUDED.n_print_layers,"
        " layer_duration_s_median = EXCLUDED.layer_duration_s_median,"
        " laser_on_s = EXCLUDED.laser_on_s,"
        " power_w_mean = EXCLUDED.power_w_mean,"
        " power_w_max = EXCLUDED.power_w_max,"
        " temps = EXCLUDED.temps, layers = EXCLUDED.layers",
        [build_id, source, s["duration_s"], s["n_recoats"],
         s["n_print_layers"], s["layer_duration_s_median"], s["laser_on_s"],
         s["power_w_mean"], s["power_w_max"], Jsonb(s["temps"]),
         Jsonb(s["layers"])])


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Compute per-build telemetry summaries.")
    ap.add_argument("--builds", type=str, default=None,
                    help="Comma-separated build IDs (default: all parquets)")
    ap.add_argument("--source", choices=["parquet", "postgres"],
                    default="parquet")
    args = ap.parse_args()

    if args.builds:
        ids = [int(x) for x in args.builds.split(",")]
    elif args.source == "parquet":
        ids = sorted(int(p.stem) for p in PARQUET_DIR.glob("*.parquet"))
    else:
        print("ERROR: --source postgres requires --builds", file=sys.stderr)
        return 1

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1

    with psycopg.connect(dsn) as conn:
        conn.execute(DDL)
        for bid in ids:
            df = load_ticks(bid, args.source, conn)
            if df is None or df.is_empty():
                print(f"build {bid}: no ticks, skipped")
                continue
            s = summarize(df)
            if s is None:
                print(f"build {bid}: degenerate, skipped")
                continue
            upsert(conn, bid, args.source, s)
            print(f"build {bid}: {s['n_recoats']} recoats, "
                  f"{s['n_print_layers']} print layers, "
                  f"{s['duration_s'] / 3600:.1f} h, "
                  f"laser {s['laser_on_s'] / 60:.0f} min")
        conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
