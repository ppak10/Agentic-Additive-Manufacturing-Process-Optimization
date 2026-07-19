"""Runtime configuration for the task runner (env-driven)."""
from __future__ import annotations

import os
from pathlib import Path

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgres://inova:inova@localhost:5432/inova"
)

# Repo root: this file is services/pipeline/agentic_sls/tasks/config.py, so the
# repo root is four parents up. Overridable for non-standard checkouts.
REPO_ROOT = Path(
    os.environ.get("REPO_ROOT", str(Path(__file__).resolve().parents[4]))
)

PORT = int(os.environ.get("TASKS_PORT", "3300"))

# Cap the log column so a chatty job can't bloat the row; we keep the tail.
LOG_TAIL_CHARS = int(os.environ.get("TASKS_LOG_TAIL_CHARS", "20000"))
