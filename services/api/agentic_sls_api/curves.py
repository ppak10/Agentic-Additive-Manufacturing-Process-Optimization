"""Stress-strain curves for the ASTM Tests page.

Mirrors the HuggingFace dataset's plot pipeline (Agentic-SLS-ASTM
scripts/plots/): the full stress-strain trace lives in each specimen's JSONL
(`curves.strain` + `curves.stress_pa`, ~2000 pts), NOT in Postgres. We read the
same JSONL the dataset's matplotlib figures read, resample every specimen onto a
shared per-standard strain grid (so the browser gets one aligned X axis and a
bounded payload), and hand the GUI what it needs to reproduce the composite
figure (assets/{standard}_composite.png) in recharts.

Read-only, static data → cached per standard for the process lifetime; restart
the service to pick up a dataset refresh.
"""

from __future__ import annotations

import json
from pathlib import Path

# datasets/Agentic-SLS-ASTM/data/{standard}/*.jsonl — same source as the
# dataset's scripts/plots/_lib.py load_standard(). parents[3] == repo root
# (curves.py → agentic_sls_api → api → services → repo).
_DATA_DIR = Path(__file__).resolve().parents[3] / "datasets" / "Agentic-SLS-ASTM" / "data"

# Resample resolution. The raw traces are ~2000 pts; 120 preserves the curve
# shape while keeping the whole-standard payload small (~54 specimens).
N_GRID = 120

_cache: dict[str, dict] = {}


def _interp(grid: list[float], xs: list[float], ys: list[float]) -> list[float | None]:
    """Linear interpolation of ys(xs) onto grid. None past the specimen's last
    strain (so a curve that breaks early ends its line instead of flat-lining).
    Both grid and xs are monotonically increasing, so one forward pointer does it."""
    out: list[float | None] = []
    n = len(xs)
    xmax = xs[-1]
    j = 0
    for g in grid:
        if g > xmax:
            out.append(None)
            continue
        if g <= xs[0]:
            out.append(round(ys[0], 3))
            continue
        while j + 1 < n and xs[j + 1] < g:
            j += 1
        x0, x1 = xs[j], xs[j + 1]
        y0, y1 = ys[j], ys[j + 1]
        out.append(round(y0 if x1 == x0 else y0 + (g - x0) / (x1 - x0) * (y1 - y0), 3))
    return out


def _load_specimen(path: Path) -> dict | None:
    row = json.loads(path.read_text().splitlines()[0])
    c = row.get("curves") or {}
    pairs = [
        (s, t)
        for s, t in zip(c.get("strain") or [], c.get("stress_pa") or [])
        if s is not None and t is not None
    ]
    if len(pairs) < 2:
        return None  # degenerate (e.g. xlsx-only rows with no analyzed curve)
    strain = [p[0] for p in pairs]
    stress_mpa = [p[1] / 1e6 for p in pairs]
    return {
        "sample_id": row.get("sample_id") or path.stem,
        "batch": row.get("batch_label"),
        "material": row.get("material_class"),
        "strain": strain,
        "stress_mpa": stress_mpa,
        "max_strain": strain[-1],
    }


def load_curves(standard: str) -> dict:
    """{ standard, grid: [strain…], specimens: [{sample_id, batch, material,
    stress: [MPa|null…]}] } — every specimen resampled onto the shared grid."""
    if standard in _cache:
        return _cache[standard]

    d = _DATA_DIR / standard
    specs = [s for p in sorted(d.glob("*.jsonl")) if (s := _load_specimen(p))]
    if not specs:
        result = {"standard": standard, "grid": [], "specimens": []}
        _cache[standard] = result
        return result

    global_max = max(s["max_strain"] for s in specs)
    grid = [global_max * i / (N_GRID - 1) for i in range(N_GRID)]
    result = {
        "standard": standard,
        "grid": [round(g, 6) for g in grid],
        "specimens": [
            {
                "sample_id": s["sample_id"],
                "batch": s["batch"],
                "material": s["material"],
                "stress": _interp(grid, s["strain"], s["stress_mpa"]),
            }
            for s in specs
        ],
    }
    _cache[standard] = result
    return result
