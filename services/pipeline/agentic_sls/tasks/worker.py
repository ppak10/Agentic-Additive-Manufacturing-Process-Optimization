"""Single sequential worker: claim a pending task, run it, record the outcome.

Sequential (concurrency=1) is deliberate — it makes every pipeline job safe
(no parallel sls-export JSONL corruption, no same-build races) without locks.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from typing import Optional

from . import db
from .config import LOG_TAIL_CHARS
from .jobs import build_steps

POLL_SECONDS = 2.0
LOG_FLUSH_SECONDS = 1.5


def _tail(s: str) -> str:
    return s[-LOG_TAIL_CHARS:] if len(s) > LOG_TAIL_CHARS else s


def _emit_complete(task: dict, status: str, error: Optional[str]) -> None:
    # Best-effort notification signal into the existing events log.
    try:
        db.insert_event(
            build_id=task.get("build_id"),
            kind="task_complete",
            message=f"{task['kind']} {status}",
            payload={"task_id": task["id"], "kind": task["kind"],
                     "status": status, "error": error},
        )
    except Exception:
        pass


def run_task(task: dict) -> None:
    task_id = task["id"]
    args = task.get("args") or {}
    try:
        _desc, steps = build_steps(task["kind"], args)
    except Exception as e:  # bad args / unknown kind
        db.finish_task(task_id, "failed", log=f"invalid task: {e}", error=str(e))
        _emit_complete(task, "failed", str(e))
        return

    buf: list[str] = []
    last_flush = time.monotonic()
    total = len(steps)

    for i, step in enumerate(steps):
        # step header (visible in the log; also drives the progress fraction for
        # multi-step chains like refresh_build)
        buf.append(f"\n=== [{i + 1}/{total}] {step.label} ===\n")
        db.update_task(task_id, log=_tail("".join(buf)), progress=i / total)

        env = {**os.environ, **(step.env or {})}
        proc = subprocess.Popen(
            step.cmd, cwd=str(step.cwd), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            buf.append(line)
            now = time.monotonic()
            if now - last_flush >= LOG_FLUSH_SECONDS:
                db.update_task(task_id, log=_tail("".join(buf)))
                last_flush = now
        proc.wait()

        if proc.returncode != 0:
            log = _tail("".join(buf))
            err = f"step '{step.label}' failed (exit code {proc.returncode})"
            db.finish_task(task_id, "failed", log=log, error=err)
            _emit_complete(task, "failed", err)
            return

    log = _tail("".join(buf))
    db.finish_task(task_id, "succeeded", log=log, progress=1.0,
                   result={"steps": total})
    _emit_complete(task, "succeeded", None)


def worker_loop(stop: threading.Event) -> None:
    db.ensure_schema()
    orphaned = db.reconcile_orphans()
    if orphaned:
        print(f"reconciled {orphaned} orphaned running task(s) from a prior restart")
    while not stop.is_set():
        try:
            task = db.claim_next()
        except Exception:
            stop.wait(POLL_SECONDS)
            continue
        if task is None:
            stop.wait(POLL_SECONDS)
            continue
        try:
            run_task(task)
        except Exception as e:  # never let one job kill the loop
            try:
                db.finish_task(task["id"], "failed", log="", error=f"worker error: {e}")
            except Exception:
                pass


def start_worker() -> threading.Event:
    stop = threading.Event()
    threading.Thread(target=worker_loop, args=(stop,), daemon=True,
                     name="task-worker").start()
    return stop
