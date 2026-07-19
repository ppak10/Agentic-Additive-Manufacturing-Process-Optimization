"""Job registry: task kind -> ordered list of steps (each a subprocess).

Most kinds are a single step; `refresh_build` chains the whole per-build
pipeline. Adding a kind here is the only extension point — the worker and API
are generic over this map.

Two execution environments:
- **pipeline** (python 3.12, the container's own venv): the `sls-*` commands,
  run via `uv run --frozen` (the env is synced on container boot).
- **dataset** (python 3.13, the Telemetry dataset's deps): the `scripts/*` build
  scripts, run in the dataset dir with a dataset-local `.tasks-venv` via
  `UV_PROJECT_ENVIRONMENT`; plain `uv run` so uv provisions that env on first use.

Concurrency note: the worker is single/sequential, which is what makes these
safe (sls-export rewrites shared JSONL; parallel runs would race). Don't add
parallelism without per-build locking.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .config import REPO_ROOT

DATASET = REPO_ROOT / "datasets" / "Agentic-SLS-Telemetry"
# Dataset scripts (ticks/peregrine) need their OWN venv (python 3.13 + dataset
# deps), kept separate from the pipeline venv and from the host's .venv.
DATASET_ENV = {"UV_PROJECT_ENVIRONMENT": str(DATASET / ".tasks-venv")}


@dataclass(frozen=True)
class Step:
    label: str
    cwd: Path
    cmd: list[str]
    env: Optional[dict] = None  # extra env merged over os.environ for the subprocess


@dataclass(frozen=True)
class JobSpec:
    describe: Callable[[dict], str]
    steps: Callable[[dict], list[Step]]


# ── arg helpers ────────────────────────────────────────────────────────────────

def _builds(a: dict) -> str:
    """Comma-list ok: '48' or '48,49'. Used by export/summarize."""
    v = a.get("builds")
    if v in (None, ""):
        v = a.get("build_id")
    if v in (None, ""):
        raise ValueError("requires 'builds' or 'build_id'")
    return str(v)


def _one(a: dict) -> str:
    """Exactly one build id. Used by per-build jobs (labels/frames/ticks/…)."""
    v = a.get("build_id")
    if v in (None, ""):
        v = a.get("builds")
    if v in (None, "") or "," in str(v):
        raise ValueError("requires a single 'build_id'")
    return str(v)


def _pipe(*args: str) -> list[str]:
    # pipeline env is synced on boot → --frozen (no re-resolve)
    return ["uv", "run", "--frozen", *args]


def _ds(*args: str) -> list[str]:
    # dataset env syncs on first use → plain uv run
    return ["uv", "run", *args]


# ── step builders (reused by the single-kind jobs and the chain) ───────────────

def _export(a):    return Step("export", REPO_ROOT, _pipe("sls-export", "--builds", _builds(a)))
def _summarize(a): return Step("summarize", REPO_ROOT, _pipe("sls-summarize-builds", "--builds", _builds(a), "--source", "postgres"))
def _labels(a):    return Step("export_labels", REPO_ROOT, _pipe("sls-export-labels", "--build", _one(a)))
def _frames(a):    return Step("deliver_frames", REPO_ROOT, _pipe("sls-deliver-frames", "--build", _one(a)))
def _ticks(a):     return Step("ticks", DATASET, _ds("scripts/ticks/01_extract.py", _one(a)), DATASET_ENV)
def _peregrine(a): return Step("peregrine", DATASET, _ds("scripts/peregrine/01_extract.py", _one(a)), DATASET_ENV)
def _analyze(a):   return Step("analyze_build", REPO_ROOT, _pipe("sls-analyze-build", "--build", _one(a)))


JOBS: dict[str, JobSpec] = {
    # Diagnostic: harmless subprocess in the pipeline env → proves the runner.
    "selftest": JobSpec(
        lambda a: "selftest",
        lambda a: [Step("selftest", REPO_ROOT, _pipe(
            "python", "-c",
            "import platform; print('selftest ok — python', platform.python_version())"))],
    ),
    "export":         JobSpec(lambda a: f"export · build {_builds(a)}",    lambda a: [_export(a)]),
    "summarize":      JobSpec(lambda a: f"summarize · build {_builds(a)}", lambda a: [_summarize(a)]),
    "export_labels":  JobSpec(lambda a: f"labels · build {_one(a)}",       lambda a: [_labels(a)]),
    "deliver_frames": JobSpec(lambda a: f"frames · build {_one(a)}",       lambda a: [_frames(a)]),
    "ticks":          JobSpec(lambda a: f"ticks · build {_one(a)}",        lambda a: [_ticks(a)]),
    "peregrine":      JobSpec(lambda a: f"peregrine · build {_one(a)}",    lambda a: [_peregrine(a)]),
    # Anomaly triage — scan chamber frames, queue candidates into
    # anomaly_candidates for the Labeling page. Needs frames on local disk.
    "analyze_build":  JobSpec(lambda a: f"triage · build {_one(a)}",       lambda a: [_analyze(a)]),
    # Full per-build refresh, in dependency order.
    "refresh_build": JobSpec(
        lambda a: f"refresh · build {_one(a)}",
        lambda a: [_export(a), _summarize(a), _labels(a), _frames(a), _ticks(a), _peregrine(a)],
    ),
}


def build_steps(kind: str, args: dict) -> tuple[str, list[Step]]:
    spec = JOBS.get(kind)
    if spec is None:
        raise ValueError(f"unknown task kind: {kind!r}; known: {sorted(JOBS)}")
    a = args or {}
    return spec.describe(a), spec.steps(a)
