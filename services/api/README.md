# agentic-sls-api

The GUI's lightweight backend (FastAPI, `:3400`). Serves stateless routes for
the React dashboard — Postgres reads now, Inova plugin/firmware proxies in
later phases — peeled off the recorder so they aren't gated behind the
recorder's restart constraints (you can't restart the recorder mid-print).

**Stateless reader.** No recording, no live-print state, no NVMe spool. Safe to
restart anytime.

## Routes

- `GET /health` — liveness (pings Postgres).
- `GET /api/astm` — every ASTM specimen (`astm_specimens`), joined to its
  printed job's name. One row per tested specimen; metrics in SI (the GUI
  formats to MPa). Requires `sls-sync-reference` to have populated the
  reference tables.

## Run

Docker (normal): `docker compose up -d api` from the repo root. Deps are synced
into `.api-venv` on first boot.

Local (dev): `uv run sls-api-server` from the repo root (reads `DATABASE_URL`
from `.env`; `API_PORT` defaults to 3400).

Dep changes: edit `pyproject.toml`, `uv lock`, then `docker compose up -d --build api`.

## Migration status

Phase 1 (done): ASTM reads. Next: reference/registry reads (`/api/registry`,
build card), datasets summary, calibrations, firmware camera/info, and plugin
CRUD proxies. Live/stateful routes (telemetry stream, spool playback, position
fan-out, operator-feedback override writes) stay in the recorder by design.
