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
  server (npm `@ppak10/agentic-sls-mcp`): 14 printer-control + 7 knowledge
  tools, identical for all four harnesses (Claude Code, OpenCode, Codex,
  Antigravity `agy`). Ground rules: `services/plugins/AGENTS.md`. Jobs +
  profiles tools (2026-07-18): `[TEMPLATE]`-named jobs are operator-blessed
  layouts — agents instantiate via job_create_from_template, never modify;
  profile_set upserts profiles (system Default refused); printer_status
  merges recorder job/phase/recording state (RECORDER_BASE_URL).
- `services/harness/` — uniform headless driver (`run.ts`), chat broker
  (`server.ts`, :3100, SSE), conversation store (`store.ts`), backfill,
  panel mode (`panel.ts`: `/agent/panel*` — 4-harness blinded fan-out,
  `agent_selections` labels incl. `user_authored`, `conversation_builds`
  one-to-many span tracking, event watcher auto-fans-out alerting
  defect_detection events to the console panel). Two agent surfaces
  (2026-07-18): Mission Control's PanelConsole (4-harness arena; sonar
  ping + browser notification on alerts/candidates) and interactive
  single-harness chats on `/conversations/:id` — messaging is keyed by
  CONVERSATION id (`POST /agent/conversations/:id/messages`, SSE); the
  broker rehydrates the in-memory chat from the conversation row after
  restarts (cli_session_id resume). `agent_conversations.debug` flags
  dev/test conversations — excluded from the Conversations dataset export
  (everything pre-2026-07-18 is flagged); toggle via GUI badge or
  `PATCH /agent/conversations/:id` (cascades to panel candidates).
- `services/web/` — React/Vite dashboard (:5173, docker compose, vite dev
  mode + HMR): Builds registry pages, conversation pages (sidebar recents
  + interactive chat, `/conversations/new` draft; the Agents session
  browser page was removed 2026-07-18), Mission
  Control (chamber card with thermal/defect/exclude-object overlays —
  click a part outline → confirm → exclude; PanelConsole agent chat; the
  old right-docked sidebar chat is REMOVED). UI = canonical neobrutalism
  registry components ONLY (shadcn from neobrutalism.dev/r/<name>.json);
  hand-roll simple table sort/paging — TanStack was deliberately removed.
  App shell is capped `h-svh` (App.tsx SidebarInset) — LOAD-BEARING for
  every page-internal scroll area; min-height alone makes pages overflow
  the window. Pages portal page-scoped actions into the
  `#breadcrumb-actions` slot in the breadcrumb row. Jobs page: selection
  is route-backed via ONE optional-param route `/jobs/:id?` (two routes
  would remount and lose sort/paging state); crumb label rides
  `location.state.breadcrumb`; Print Profiles (`/profiles/:id?`) mirrors
  the same architecture with a react-hook-form detail card (neobrutalism
  Form registry component, data-driven field spec); job card has a dual 3D build preview
  (`panels/JobPreview3D.tsx` — whole nested build + selected part) fed by
  the plugin's stored-job endpoints `/api/jobs/:id/instances` +
  `/api/jobs/:id/meshes/:hash` (work while idle, unlike
  `/api/printing/*`; deployed 2026-07-18).
- `services/defect/` — defect-detection bridge (:3200): thin client of the
  v05 model server on the MAIL-10 workstation (`ssh 10`, serve.py :8100,
  GPU; started via `runs/v05/deploy.sh` with linuxbrew on PATH). Watches
  z2 steps on `/api/stream`, buffers chamber/galvo frames per layer, POSTs
  `/infer`, writes `events` rows (kind='defect_detection') + serves
  `/defect/latest` to the Mission Control attention bar + anomaly-map
  overlay on the chamber feed (maps span the FULL frame — model input is
  the whole chamber view resized square, no bed registration). NOTIFY-ONLY —
  never commands the printer; safe to restart mid-print. `/infer` takes
  no plotter_commands (scan mask derives from galvo frames); `alerts` in
  the response is an ARRAY of class names, not a map. Infers ONLY during
  the Printing phase (Heating/BedPreparation frames false-alert at
  0.7–0.98). Operator verdicts on alerts (attention bar, three-state:
  correct / ignored / incorrect — "ignored" = seen but not acted on,
  neither a positive nor negative label) → `defect_feedback` events
  referencing the defect_detection row — the Inova training-label
  channel.
- `services/pipeline/` — Python data pipeline + its tests (own
  pyproject; root pyproject is a virtual uv-workspace stub. Console
  scripts, run from root:
  `uv run sls-<export|export-conversations|sync-reference|summarize-builds|match-build-sessions|merge-builds|deliver-frames|backfill-frames|restore-builds|export-labels|backfill-camera-bboxes>`).
  `sls-merge-builds --into W --from L [L2 …] [--apply]` folds recorder builds
  that a restart split across one PrintSession into a canonical winner:
  repoints every build-keyed child row L→W, extends W's window, and TOMBSTONES
  each loser (`builds.merged_into = W`, row kept so refs still resolve; the
  `build_registry` view hides merged rows). Dry-run by default; refuses builds
  that don't share an `inova_session_id` unless `--force`. Re-run
  `sls-summarize-builds --build W` after.
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
stop-after-build exit STAYS stopped), defect (`agentic-sls-defect`,
notify-only bridge to the MAIL-10 model server — safe to restart
anytime). Each node service owns its
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
- **Operator feedback lives in `events`** (exported to Telemetry as
  `recorder/events.jsonl`): `operator_action` (every GUI override POST —
  recoater passes, layer/setup overrides, part exclusion with part
  transform+bounds and latest defect stimulus attached; written by
  `services/recorder/src/recorder/feedback.ts` at the proxy choke point),
  `build_layout` (parts array + camera/thermal calibration, at build
  start and on exclusion change), `layer_objects` (plotter per-layer
  object set, on version change, + derived `camera_bboxes` per object —
  chamber-image coords through the operator-measured homography),
  `defect_feedback` (verdicts from Mission Control via the defect
  bridge). **Training labels live in `defect_labels`** (MUTABLE table —
  curation, not telemetry: status active/rejected, sources
  live/replay/manual). GUI: Datasets → Telemetry → per-build label lab
  (replay scrubber, mock inference via bridge `/defect/replay` — no
  events written, blob verdicts + hand-drawn regions). Export:
  `uv run sls-export-labels` → Telemetry `source/labels/<NNN>.parquet`
  per build; all-rejected builds get their labels parquet PRUNED; HF push
  stays a manual git commit (the human gate). Coordinates stay NATIVE — calibration block in build_layout
  does the projection downstream; it includes `plotter_to_camera`
  (quad + fisheye k1). Calibration source of truth: **`calibrations`
  table** (append-only, latest per kind wins — history matters for
  interpreting old builds; kinds: plotter_to_camera, thermal_to_plotter
  — the thermal grid renders through H∘T, composed in MissionControl). Web Align saves → POST
  `/api/calibration/plotter_to_camera` (+ localStorage echo; newest
  timestamp wins across browsers); recorder feedback.ts polls it (~30 s);
  .env VITE_PLOTTER_* is bootstrap fallback only. Web overlay and
  recorder feedback.ts share the projection math — keep in sync.
  Agent `*_set` calls log to `agent_actions` (MCP server) instead.
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
  MUST get an explicit `--model` (its free zen default errors upstream);
  harness CLIs run with cwd=services/plugins/ (re-register Claude's
  plugin marketplace from that path after moves). (The analyst/operator
  chat presets were removed 2026-07-18 — every chat gets the full MCP
  tool surface; note `--allowedTools` doesn't restrict Claude's built-ins.)
- Three.js chamber views (`BuildLayout3D`/`JobPreview3D`): firmware
  transforms are row-major V·M — transpose for THREE; stored-job
  `MeshPrintTransform` expects the mesh RECENTERED on its bounds
  (apply `translate(−boundsCenter)` before the world matrix); invisible/
  transparent materials MUST set `depthWrite={false}` (an opacity-0 box
  still writes depth and occludes parts at some camera poses); keep part
  materials opaque; `frustumCulled={false}` on hand-matrixed meshes.
  Recoater sweeps along X — powder −X → overflow +X (axis
  operator-confirmed; flip the BuildLayout3D side constants if the ends
  are backwards).
- Profile names can lie (a "20mJ/mm" profile contains 15) — read the JSON
  field, never the name.
- Print-profile thickness fields are MICROMETERS (layerThickness 100,
  bedPreparationThickness 13000) — the pre-2026-07-18 GUI mislabeled them
  mm and could never edit them. Profile field bounds live in THREE places
  that must stay in sync: plugin `PrintProfileEndpoints._bounds` (the
  enforced chokepoint — the firmware model has NO validation of its own),
  the MCP profile_set zod schema, and the GUI form field spec. Temps cap
  at 200 °C by deliberate choice. A raw profile JSON carries a ~250 KB
  `stats` blob — always project it away before returning to a model.
- Firmware `CloneJob` keeps the raw requested name on the returned object
  while sanitizing the filename ("/" → "_") — re-fetch via TryGetJob
  before any follow-up UpsertJob or it throws FileNotFound.
- `docker compose` commands MUST run from the repo root: service folders
  have their own compose.yml, so running from services/<svc>/ resolves an
  empty project and silently no-ops (the container keeps old code —
  symptom: no "Container … Restarting" output).
- Inova plugin deploys: build.sh → commit+push the plugin submodule →
  ON THE PRINTER `cd ~/GitHub/Inova-API-Plugin && git pull && ./install.sh`
  → restart firmware (user-run). Skipping pull or install.sh leaves the
  old DLL running — verify by probing an endpoint, not by assumption.
- One firmware PrintSession can span multiple recorder builds (restarts);
  the registry maps builds→sessions via `builds.inova_session_id`.
- Destructive printer actions (reboot/kill/restart) are user-executed;
  recommend and verify only.
