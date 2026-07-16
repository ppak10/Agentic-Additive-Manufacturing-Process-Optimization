"""Summarizer logic on synthetic tick streams: layer detection, laser duty,
print-layer classification, thermal tracking error."""

from datetime import datetime, timedelta, timezone

import polars as pl
import pytest

from agentic_sls.pipeline.summarize_builds import summarize


T0 = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)


def ticks(rows):
    """rows: (offset_s, sensor_id, kind, value)"""
    return pl.DataFrame(
        {
            "ts": [T0 + timedelta(seconds=r[0]) for r in rows],
            "sensor_id": [r[1] for r in rows],
            "kind": [r[2] for r in rows],
            "value": [float(r[3]) for r in rows],
        }
    )


def z2_steps(levels, period_s=10.0, samples_per_level=6):
    """z2 plateau series: samples_per_level readings at each level."""
    rows = []
    t = 0.0
    for level in levels:
        for _ in range(samples_per_level):
            rows.append((t, "positions", "position.z2", level))
            t += period_s
    return rows


def test_recoat_detection_counts_z2_steps():
    s = summarize(ticks(z2_steps([0, 100, 200, 300])))
    assert s["n_recoats"] == 3
    assert len(s["layers"]) == 3


def test_z2_moves_outside_step_range_ignored():
    # 20 µm jitter and a 13 mm bed-prep drop are not recoats.
    rows = z2_steps([0, 20, 13020, 13120])
    s = summarize(ticks(rows))
    assert s["n_recoats"] == 1  # only the 100 µm step at the end


def test_print_layers_are_recoats_with_laser_fire():
    rows = z2_steps([0, 100, 200, 300])
    window = 60.0  # each level lasts 6 samples * 10 s
    # Laser fires only during the second recoat window (t in [120, 180)).
    for t in range(0, 240, 5):
        on = 1.0 if window * 2 <= t < window * 3 else 0.0
        rows.append((float(t), "laser", "power", on))
    s = summarize(ticks(rows))
    assert s["n_recoats"] == 3
    assert s["n_print_layers"] == 1
    assert s["laser_on_s"] == pytest.approx(55, abs=10)
    fired = [l for l in s["layers"] if l["laser_on_s"] > 0]
    assert len(fired) == 1


def test_thermal_tracking_error_only_where_target_set():
    rows = z2_steps([0, 100])
    rows += [
        # printBed tracks a 170 °C target 2 °C hot.
        (0.0, "printBed", "temp.current", 172.0),
        (0.0, "printBed", "temp.target", 170.0),
        (10.0, "printBed", "temp.current", 172.0),
        (10.0, "printBed", "temp.target", 170.0),
        # quadrant1 has no target — must not appear.
        (0.0, "quadrant1", "temp.current", 150.0),
        (0.0, "quadrant1", "temp.target", 0.0),
    ]
    s = summarize(ticks(rows))
    assert s["temps"]["printBed"]["dev_mean"] == pytest.approx(2.0)
    assert s["temps"]["printBed"]["current_max"] == pytest.approx(172.0)
    assert "quadrant1" not in s["temps"]


def test_per_layer_bed_temp_mean():
    rows = z2_steps([0, 100, 200])
    # Bed at 170 during recoat 1's window, 180 during recoat 2's.
    for t in range(60, 120, 10):
        rows.append((float(t), "printBed", "temp.current", 170.0))
    for t in range(120, 180, 10):
        rows.append((float(t), "printBed", "temp.current", 180.0))
    s = summarize(ticks(rows))
    assert s["layers"][0]["print_bed_c"] == pytest.approx(170.0)
    assert s["layers"][1]["print_bed_c"] == pytest.approx(180.0)


def test_power_rollup():
    rows = z2_steps([0, 100])
    rows += [(float(t), "powerman", "power.current", w)
             for t, w in [(0, 1000.0), (10, 2000.0), (20, 3000.0)]]
    s = summarize(ticks(rows))
    assert s["power_w_mean"] == pytest.approx(2000.0)
    assert s["power_w_max"] == pytest.approx(3000.0)


def test_degenerate_single_instant_returns_none():
    assert summarize(ticks([(0.0, "laser", "power", 0.0)])) is None
