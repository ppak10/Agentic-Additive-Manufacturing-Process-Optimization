# Agentic SLS Process Optimization

Agentic process optimization for an SLS4All Inova MK1 SLS printer. Thesis:
compare agent harnesses/models operating the same MCP tool surface. Full
design: `wiki/Architecture.md` in the `wiki/` submodule (data plane / agent
plane / learning loop; the wiki also holds the topical reference pages).

## Layout

- `services/recorder/` — Fastify recorder (:3000): telemetry/frames/
  position → NVMe spool → Postgres import; build lifecycle; registry API
  (`/api/registry`).
- `services/plugins/` — the harness-facing project root (all four CLIs
  spawn with this as cwd, so each harness's native discovery — `.mcp.json`,
  `.claude-plugin/`, `.opencode/`, `gemini-extension.json`, `.agents/` —
  anchors here, not the dev repo). `mcp/` inside is the TypeScript MCP
  server (npm `@ppak10/agentic-sls-mcp`): 7 printer-control + 7 knowledge
  tools, identical for all four harnesses (Claude Code, OpenCode, Codex,
  Antigravity `agy`). Ground rules: `services/plugins/AGENTS.md`.
- `services/harness/` — uniform headless driver (`run.ts`), chat broker
  (`server.ts`, :3100, SSE), conversation store (`store.ts`), backfill.
- `services/web/` — React/Vite dashboard (:5173, docker compose, vite dev
  mode + HMR): Builds registry pages, Agents session browser, right-docked
  agent chat panel.
- `services/pipeline/` — Python data pipeline + its tests (own
  pyproject; root pyproject is a virtual uv-workspace stub. Console
  scripts, run from root:
  `uv run sls-<export|export-conversations|sync-reference|summarize-builds|match-build-sessions|deliver-frames|backfill-frames|restore-builds>`).
- `datasets/Agentic-SLS-Knowledge/` — curated reference corpus served by
  `reference_*` tools (its `source/`). Published HF dataset; the submodule
  pin records which corpus version agents saw. MUST stay initialized
  (unlike the big datasets, no `update = none`).
- `services/` — docker compose services (one folder per service: postgres,
  pgadmin, web — a service folder owns its compose.yml, state, and app
  code where applicable), pulled in by the root `docker-compose.yml` via
  `include:`. The root file pins `name:` — don't change it (container
  identity). Host-coupled processes stay systemd, infra goes here.

## Services — IMPORTANT

EVERYTHING runs in docker compose (2026-07-16; systemd fully retired):
postgres, pgadmin, web (hot-reloads), broker (`agentic-sls-broker` — the
four harness CLIs PINNED in its image, bumps = deliberate Dockerfile
commits, auth bind-mounted from host home), recorder
(`agentic-sls-recorder`, `restart: on-failure` so a clean
stop-after-build exit STAYS stopped). Each node service owns its
lockfile; deps are BAKED into images behind anonymous volumes — dep
changes need `docker compose build <svc> && docker compose up -d -V
<svc>`; source edits deploy via `docker compose restart
<recorder|broker>` at a safe moment — **never
restart or recreate the recorder while a print is being recorded**
(check `/api/health/recording`; use `POST /api/admin/stop-after-build`).
Logs: `docker logs -f agentic-sls-recorder`.

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
  explicitly; hf.co remotes need the HF SSH key). Source-based since
  2026-07-16: `sls-export` writes into Telemetry `source/`, the linkage
  CSV lives in Database `source/`, `sls-export-conversations` writes the
  Conversations `data/` file directly; `data/exports/` is retired
  (folder remains as fallback until the frames backfill completes). Raw agent transcripts write DIRECTLY
  into datasets/Agentic-SLS-Conversations/source/sessions (commit that
  repo often). (Datasets renamed Inova-Mk1-* → Agentic-SLS-* 2026-07-16;
  the old "Coversations" remote typo died in the rename.)
- Old-era (pre-2026-07-13-restore) raw telemetry lives only in
  `Agentic-SLS-Telemetry/source/telemetry/*.parquet` (pushed to HF), not
  Postgres — summarize from parquet, never `--source postgres` for big
  builds (fetch too slow).

## Commands

- Tests: `uv run pytest` (root, pipeline suite) · `npm test` + `npm run typecheck` +
  `npx tsx tests/smoke.ts` (services/plugins/mcp/, needs DATABASE_URL
  exported).
- Headless agent run: `services/harness/node_modules/.bin/tsx services/harness/run.ts <harness> --prompt '…'` (no root node_modules — bare `npx tsx` at root would fetch an unpinned tsx).
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
  `~/.gemini/config/mcp_config.json`; opencode resolves the project root
  via git toplevel (root `.opencode/` shim registers the MCP server) and
  MUST get an explicit `--model` (its free zen default errors upstream); analyst-preset chats deny Claude's
  Bash/Edit/Write (built-ins aren't restricted by `--allowedTools`);
  harness CLIs run with cwd=services/plugins/ (re-register Claude's
  plugin marketplace from that path after moves).
- Profile names can lie (a "20mJ/mm" profile contains 15) — read the JSON
  field, never the name.
- One firmware PrintSession can span multiple recorder builds (restarts);
  the registry maps builds→sessions via `builds.inova_session_id`.
- Destructive printer actions (reboot/kill/restart) are user-executed;
  recommend and verify only.
