"""Per-build dataset artifact existence — drives the build-page "already
exported?" readout. Pure filesystem checks against the Telemetry dataset."""
from __future__ import annotations

from .jobs import DATASET

# order matches the refresh_build pipeline order
ARTIFACTS = {
    "telemetry":    lambda n: DATASET / "source" / "telemetry" / f"{n:03d}.parquet",
    "position":     lambda n: DATASET / "source" / "position_hf" / f"{n:03d}.parquet",
    "labels":       lambda n: DATASET / "source" / "labels" / f"{n:03d}.parquet",
    "frames":       lambda n: DATASET / "source" / "frames" / f"{n:03d}",
    "frames_index": lambda n: DATASET / "data" / "frames_index" / f"{n:03d}.parquet",
    "ticks":        lambda n: DATASET / "data" / "ticks" / f"{n:03d}.parquet",
    "peregrine":    lambda n: DATASET / "data" / "peregrine" / f"{n:03d}.parquet",
}


def build_status(build_id: int) -> dict[str, bool]:
    return {name: path(build_id).exists() for name, path in ARTIFACTS.items()}
