# Agentic SLS Process Optimization

Agentic process optimization for an SLS4All Inova MK1 SLS printer. Thesis:
compare agent harnesses/models operating the same MCP tool surface. Full
design: `wiki/Architecture.md` in the `wiki/` submodule (data plane / agent
plane / learning loop; the wiki also holds the topical reference pages).

## Layout

- `server/` — Fastify recorder (:3000): telemetry/frames/position → NVMe
  spool → Postgres import; build lifecycle; registry API (`/api/registry`).
- `plugin/` — TypeScript MCP server (npm `@ppak10/agentic-sls-mcp`):
  7 printer-control + 7 knowledge tools, identical for all four harnesses
  (Claude Code, OpenCode, Codex, Antigravity `agy`). Tool registry and
  ground rules: `plugin/AGENTS.md`.
- `harness/` — uniform headless driver (`run.ts`), chat broker
  (`server.ts`, :3100, SSE), conversation store (`store.ts`), backfill.
- `services/web/` — React/Vite dashboard (:5173, docker compose, vite dev
  mode + HMR): Builds registry pages, Agents session browser, right-docked
  agent chat panel.
- `agentic_sls/pipeline/` — Python data pipeline (console scripts:
  `uv run sls-<export|export-conversations|sync-reference|summarize-builds|match-build-sessions|restore-builds>`).
- `datasets/Agentic-SLS-Knowledge/` — curated reference corpus served by
  `reference_*` tools (its `source/`). Published HF dataset; the submodule
  pin records which corpus version agents saw. MUST stay initialized
  (unlike the big datasets, no `update = none`).
- `services/` — docker compose services (one folder per service: postgres,
  pgadmin, web — a service folder owns its compose.yml, state, and app
  code where applicable), pulled in by the root `docker-compose.yml` via
  `include:`. The root file pins `name:` — don't change it (container
  identity). Host-coupled processes stay systemd, infra goes here.
- `deploy/systemd/` — user units: agentic-recorder, agentic-broker,
  agentic-web (`deploy/systemd/install.sh`).

## Services — IMPORTANT

The recorder and broker run as **systemd user units without tsx watch**:
editing `server/src` or `harness/` does NOT hot-reload. The dashboard runs
in docker compose (`agentic-sls-web`, vite dev — web edits DO hot-reload).
Deploy = `systemctl --user restart agentic-<recorder|broker>` at a
safe moment — **never restart the recorder while a print is being
recorded** (check `/api/health/recording`; use
`POST /api/admin/stop-after-build` for graceful maintenance windows).
Logs: `journalctl --user -u agentic-recorder -f`.

## Data

- **Postgres** (docker `agentic-sls-postgres`, DATABASE_URL in `.env`) is
  the single query surface: recording tables + synced reference copies
  (`inova_jobs/…profiles/…sessions`, `astm_specimens`), `build_registry`
  view, `build_summaries`, `agent_conversations/…sessions/…messages`,
  `agent_actions`. Reference tables are COPIES — fix data at its origin
  repo and re-run `uv run sls-sync-reference`.
- **HF dataset repos**: Agentic-SLS-{Telemetry,Database,ASTM,Conversations}
  are submodules under `datasets/` (Telemetry is 566 GB; all have
  `update = none` — NEVER blanket `--recurse-submodules`; init submodules
  explicitly; hf.co remotes need the HF SSH key). All read from
  `data/exports/` by relative path. Raw agent transcripts write DIRECTLY
  into datasets/Agentic-SLS-Conversations/source/sessions (commit that
  repo often). (Datasets renamed Inova-Mk1-* → Agentic-SLS-* 2026-07-16;
  the old "Coversations" remote typo died in the rename.)
- Old-era (pre-2026-07-13-restore) raw telemetry lives only in
  `data/exports/telemetry/*.parquet`, not Postgres — summarize from
  parquet, never `--source postgres` for big builds (fetch too slow).

## Commands

- Tests: `uv run pytest` (root) · `npm test` + `npm run typecheck` +
  `npx tsx tests/smoke.ts` (plugin/, needs DATABASE_URL exported).
- Headless agent run: `npx tsx harness/run.ts <harness> --prompt '…'`.
- Post-print refresh: `sls-export` → `sls-summarize-builds` →
  (new sessions?) rsync `ppak@inova:/home/ppak/SLS4All/PrintSessions/`
  into `sls4all/SLS4All-Backup` (submodule, 10 GB, `update = none`) +
  Database repo, then `sls-sync-reference`.

## Conventions & gotchas

- TypeScript over JavaScript for new JS-adjacent code; Python scripts run
  via `uv run`; install CLI tools with brew.
- Postgres: two-arg `round()` needs `::numeric`.
- MCP knowledge tools are read-only by construction (forced read-only
  pool); `agent_actions` logs every `*_set` call server-side — expected
  behavior, not something to bypass.
- codex exec needs `--dangerously-bypass-approvals-and-sandbox` for MCP
  (openai/codex#16685); agy reads MCP config ONLY from
  `~/.gemini/config/mcp_config.json`; analyst-preset chats deny Claude's
  Bash/Edit/Write (built-ins aren't restricted by `--allowedTools`).
- Profile names can lie (a "20mJ/mm" profile contains 15) — read the JSON
  field, never the name.
- One firmware PrintSession can span multiple recorder builds (restarts);
  the registry maps builds→sessions via `builds.inova_session_id`.
- Destructive printer actions (reboot/kill/restart) are user-executed;
  recommend and verify only.
