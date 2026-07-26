"""Postgres access for the task runner.

The `tasks` table is the mutable job-lifecycle surface (queue + current state +
history). We also write a `task_complete` row into the existing `events` table
on finish so the GUI's events-based notification path can surface it — but task
*state* lives here, not in the append-only events log.
"""
from __future__ import annotations

from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .config import DATABASE_URL

# Split statements: psycopg's extended protocol runs one statement per execute.
DDL_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS tasks (
      id         BIGSERIAL PRIMARY KEY,
      kind       TEXT NOT NULL,
      args       JSONB NOT NULL DEFAULT '{}'::jsonb,
      build_id   BIGINT,
      status     TEXT NOT NULL DEFAULT 'pending',
      progress   REAL,
      log        TEXT NOT NULL DEFAULT '',
      result     JSONB,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ended_at   TIMESTAMPTZ
    )
    """,
    "CREATE INDEX IF NOT EXISTS tasks_status_created ON tasks (status, created_at)",
]


def connect() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True)


def ensure_schema() -> None:
    with connect() as conn:
        for stmt in DDL_STATEMENTS:
            conn.execute(stmt)


def insert_task(kind: str, args: dict, build_id: Optional[int] = None) -> dict:
    with connect() as conn:
        return conn.execute(
            "INSERT INTO tasks (kind, args, build_id) VALUES (%s, %s, %s) RETURNING *",
            (kind, Jsonb(args or {}), build_id),
        ).fetchone()


def list_tasks(status: Optional[str] = None, limit: int = 100) -> list[dict]:
    with connect() as conn:
        if status:
            return conn.execute(
                "SELECT * FROM tasks WHERE status = %s ORDER BY created_at DESC LIMIT %s",
                (status, limit),
            ).fetchall()
        return conn.execute(
            "SELECT * FROM tasks ORDER BY created_at DESC LIMIT %s", (limit,)
        ).fetchall()


def get_task(task_id: int) -> Optional[dict]:
    with connect() as conn:
        return conn.execute("SELECT * FROM tasks WHERE id = %s", (task_id,)).fetchone()


def claim_next() -> Optional[dict]:
    """Atomically claim the oldest pending task (single-worker, but correct under
    concurrency via FOR UPDATE SKIP LOCKED). Commits immediately (autocommit)."""
    with connect() as conn:
        return conn.execute(
            """
            UPDATE tasks SET status = 'running', started_at = now()
            WHERE id = (
              SELECT id FROM tasks WHERE status = 'pending'
              ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING *
            """
        ).fetchone()


def update_task(task_id: int, *, log: Optional[str] = None,
                progress: Optional[float] = None) -> None:
    sets, params = [], []
    if log is not None:
        sets.append("log = %s")
        params.append(log)
    if progress is not None:
        sets.append("progress = %s")
        params.append(progress)
    if not sets:
        return
    params.append(task_id)
    with connect() as conn:
        conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = %s", params)


def finish_task(task_id: int, status: str, log: str,
                result: Optional[dict] = None, error: Optional[str] = None,
                progress: Optional[float] = None) -> None:
    with connect() as conn:
        conn.execute(
            """UPDATE tasks SET status = %s, ended_at = now(), log = %s,
                                result = %s, error = %s,
                                progress = COALESCE(%s, progress) WHERE id = %s""",
            (status, log, Jsonb(result) if result is not None else None, error,
             progress, task_id),
        )


def cancel_task(task_id: int) -> Optional[dict]:
    """Cancel a *pending* task. Running/finished tasks return None (v1 doesn't
    kill running jobs — sls-export mid-write would corrupt shared JSONL)."""
    with connect() as conn:
        return conn.execute(
            "UPDATE tasks SET status = 'canceled', ended_at = now() "
            "WHERE id = %s AND status = 'pending' RETURNING *",
            (task_id,),
        ).fetchone()


def reconcile_orphans() -> int:
    """Fail tasks stuck in 'running' from a prior crash/restart. The worker is
    single + sequential, so at startup nothing is legitimately running — any
    'running' row is an interrupted job (e.g. the container was recreated to
    load new code). Returns how many were reconciled."""
    with connect() as conn:
        rows = conn.execute(
            "UPDATE tasks SET status = 'failed', ended_at = now(), "
            "error = COALESCE(error || ' | ', '') || 'interrupted — task service restarted' "
            "WHERE status = 'running' RETURNING id"
        ).fetchall()
    return len(rows)


def insert_event(build_id: Optional[int], kind: str, message: str,
                 payload: dict[str, Any]) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO events (build_id, kind, message, payload) VALUES (%s, %s, %s, %s)",
            (build_id, kind, message, Jsonb(payload)),
        )
