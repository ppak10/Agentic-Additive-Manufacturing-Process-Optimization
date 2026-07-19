"""FastAPI surface for the task runner + the `sls-task-server` entrypoint.

Routes are mounted under /api/tasks so the web dev server can proxy the whole
prefix to this service; /health is separate for the container healthcheck.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import db
from .build_status import build_status
from .config import PORT
from .jobs import JOBS
from .worker import start_worker

_stop = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _stop
    db.ensure_schema()
    _stop = start_worker()
    yield
    if _stop is not None:
        _stop.set()


app = FastAPI(title="agentic-sls-tasks", lifespan=lifespan)


class CreateTask(BaseModel):
    kind: str
    args: dict[str, Any] = {}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "kinds": sorted(JOBS)}


@app.get("/api/tasks")
def list_tasks(status: Optional[str] = None, limit: int = 100) -> list[dict]:
    return db.list_tasks(status=status, limit=limit)


@app.post("/api/tasks")
def create_task(body: CreateTask) -> dict:
    if body.kind not in JOBS:
        raise HTTPException(400, f"unknown kind {body.kind!r}; known: {sorted(JOBS)}")
    raw = body.args.get("build_id", body.args.get("builds"))
    build_id: Optional[int] = None
    if isinstance(raw, (int, str)) and str(raw).isdigit():
        build_id = int(raw)  # single-build convenience column; None for multi/CSV
    return db.insert_task(body.kind, body.args, build_id=build_id)


@app.get("/api/tasks/build-status")
def build_status_endpoint(builds: str) -> dict:
    """Per-build dataset artifact existence. `builds` is a CSV of build ids.
    Declared before /api/tasks/{task_id} so the static path wins the match."""
    ids = [int(x) for x in builds.split(",") if x.strip().isdigit()]
    return {str(i): build_status(i) for i in ids}


@app.get("/api/tasks/{task_id}")
def get_task(task_id: int) -> dict:
    row = db.get_task(task_id)
    if row is None:
        raise HTTPException(404, "task not found")
    return row


@app.post("/api/tasks/{task_id}/cancel")
def cancel_task(task_id: int) -> dict:
    row = db.cancel_task(task_id)
    if row is None:
        raise HTTPException(409, "only pending tasks can be canceled")
    return row


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
