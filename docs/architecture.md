# Data-Store & Continual-Learning Architecture

How the agentic SLS system stores, links, retrieves, and learns from print
data. Status: **phases 1–3 deployed and verified (2026-07-13)**; phase 4
(learning loop) is the active frontier. Operational runbook: `CLAUDE.md`.

## Design decisions

- **Postgres is the working memory.** Every agent lookup is a SQL query
  against one database. Data *originates* in three places (the recorder,
  the printer firmware, the test lab) but is *queried* in one. Reference
  tables are synced copies — corrections happen at the origin repos and
  re-sync (`scripts/sync_reference.py`).
- **Structured query tools, not embedding RAG.** The corpus is dozens of
  highly structured records (builds, profiles, specimens), not thousands
  of documents. Filterable tools whose schemas teach the agent what exists
  beat vector search at this scale. pgvector columns (`events.embedding`,
  `frames.embedding`) stay reserved for phase 5.
- **The HF repos are the publication layer.** Four sibling datasets:
  `Inova-Mk1-{Telemetry,Database,ASTM,Conversations}`. Downstream of
  Postgres (or of their own lab/firmware sources), never the agent's query
  surface. Raw agent transcripts write DIRECTLY into the Conversations
  repo's `source/sessions/` (it is the archive; commit it often).
- **Learning lives in the data layer, not model weights.** Action history,
  conversations, playbook, and the GP surrogate grow with each build; any
  harness/model plugged in inherits all of it — required by the
  harness-comparison methodology.

## A. Data plane — deployed

```
  ORIGINS                              POSTGRES — "working memory"           PUBLICATION
  ───────                              ──────────────────────────            ───────────
  Inova Mk1 printer
   └ .NET plugin :5001 ── live ──▶   RECORDING                                export.py
      state / position / plotter       builds ⊕ inova_session_id          ┌──▶ data/exports/ ──▶
      frames (→ NVMe spool →           telemetry · position_hf · frames   │     Inova-Mk1-Telemetry
      post-print import)               events · plotter_commands          │
                                                                          │   export_conversations.py
  Firmware storage                   REFERENCE (synced copies)            │    └─▶ Inova-Mk1-Conversations
   .s4a jobs · profiles  ── sync ──▶   inova_jobs · inova_print_profiles ─┘         ▲ raw transcripts
   PrintSessions (rsync from           inova_print_sessions ·                       │ written directly
   printer → SLS4All-Backup)           astm_specimens                               │ (source/sessions)
                                       build_registry (view = the linkage)          │
  Lab (TestWorks)                                                                   │
   D638/D790 ── extract+sync ──▶     DERIVED                              agent broker & runner
                                       build_summaries (per-build           (Inova-Mk1-{Database,ASTM}
  Curated docs (TDS, Fuse1↔Inova       telemetry features)                   publish from their own
  translation) ─▶ knowledge/           agent_conversations / _sessions /     source/ trees)
                                       _messages · agent_actions
```

History note: the pre-2026-07-13 era was restored and renumbered into a
single 46-build history; **old-era raw telemetry lives only in
`data/exports/telemetry/*.parquet`**, not Postgres — summarize from
parquet.

## B. Agent plane — deployed

```
   HARNESSES (all verified)         MCP SERVER (plugin/, 14 tools)         BACKENDS
   Claude Code ──┐                ┌──────────────────────────────────┐
   OpenCode ─────┤ identical      │ CONTROL   printer_status ·       ├──▶ plugin :5001
   Codex ────────┤ tools     ───▶ │   recoater_* · layer_overrides_* │
   Antigravity ──┘                │ KNOWLEDGE data_* (builds_list,   ├──▶ Postgres (forced
        ▲                         │   build_get, astm_query,         │     read-only pool)
        │ headless                │   telemetry_summary, db_query) · │
   harness/run.ts (one-shots)     │   reference_* (knowledge/ docs)  │
   harness/server.ts (:3100) ──── │ every *_set call ──▶ agent_actions
        ▲ SSE turns, resume,      └──────────────────────────────────┘
        │ analyst/operator presets
   GUI (:5173): right-docked chat panel · Builds registry pages · Agents session browser
   INJECTED CONTEXT (not tools): plugin/AGENTS.md ground rules (+ PLAYBOOK.md, phase 4)
```

- Every session/chat turn is recorded: normalized messages in Postgres
  (`agent_conversations` → `agent_sessions` → `agent_messages`, one
  parser for all four harnesses in `harness/store.ts`), raw transcripts
  in the Conversations dataset repo. Failed runs are data too.
- Presets: **analyst** (default; read-only tools — hard-enforced for
  Claude incl. denying Bash/Edit/Write built-ins; prompt-level for the
  others, whose permission flags are all-or-nothing) vs **operator**
  (full control; GUI confirm gate; intended for zero-shot benchmarks).
- Thesis instrumentation: session rows carry (harness, model, role,
  build); OpenCode×Claude vs Claude Code×Claude isolates the harness
  variable, OpenCode×{models} isolates the model variable.

## C. Learning loop — phase 4, the active frontier

```
        ┌────────────────────────── next build's parameters ◀────────────────────────┐
        ▼                                                                             │
   PRINT RUN ──▶ agent_actions ✓ + telemetry ✓ ──▶ BUILD CARD ✓ ──▶ ASTM outcomes ✓  │
        │                (events timeline)            │                 │             │
        │                                             ▼                 ▼             │
        │                              post-session REFLECTION ◌   GP SURROGATE ◌ ───┘
        │                                (case library; derive          (predict_* /
        │                                 actions from agent_actions,    suggest_* tools)
        ▼                                 never agent self-report)            │
   vision watchdog ◌ (phase 5) ──▶ events         │                          │
   (camera+thermal+position →          PLAYBOOK distillation ◌ ──▶ injected context
    per-object exclusion via           (human-gated — a wrong lesson poisons
    plotter_commands geometry*)         every future session)
```

✓ deployed · ◌ not yet built. Build order: reflector → watchdog loop
(periodic observe-and-recommend; recommendations into `events`, human ack
in the GUI panel) → playbook → GP surrogate. *The plotter_commands stream
has never captured data — investigate before the vision phase depends on it.

## Identity & linkage (the registry) — deployed, one gap

The recorder mints integer `build_id`s; the firmware mints PrintSession
UUIDs (carrying `JobId`/`ProfileId`); the lab keys specimens by batch with
job/profile FKs. Bridge: `builds.inova_session_id`, mapped 46/46 via
`scripts/match_build_sessions.py` (timestamp-interval matching, hand-review
in `data/exports/build_to_inova_session.csv`, `--apply` to Postgres).
Facts learned: one firmware session can span multiple recorder builds
(restarts/false starts); exact start/end alignment beats overlap scoring.

**Remaining gap:** the recorder does not yet capture the active session
UUID live at print start (the plugin links against the firmware's
PrintSessions storage, so exposing it is a small .NET addition). Until
then, each new build needs a matcher propose/review pass after syncing
PrintSessions from the printer.

## Deployment

Three systemd user units (`deploy/systemd/`, linger enabled):
`agentic-recorder` (:3000), `agentic-broker` (:3100), `agentic-web`
(:5173). Units run tsx WITHOUT watch — deploys are explicit restarts at
safe moments; `POST /api/admin/stop-after-build` provides graceful
maintenance windows. Recorder lifecycle self-heals: startup orphan
reconciliation, spool recovery, unreachable-printer finalization.

## Implementation status

| Phase | Scope | Status |
|---|---|---|
| 1. Linkage | session column + backfill matcher | ✅ 2026-07-13 (live stamping still open, see above) |
| 2. Knowledge base | reference sync · build_summaries | ✅ deployed |
| 3. Tools & surfaces | data_*/reference_* tools · agent_actions · corpus · broker + GUI · conversation store · HF Conversations dataset | ✅ deployed |
| 4. Learning loop | reflector · watchdog · playbook · GP surrogate | ◌ next |
| 5. Later | pgvector embeddings · vision watchdog | ◌ |
