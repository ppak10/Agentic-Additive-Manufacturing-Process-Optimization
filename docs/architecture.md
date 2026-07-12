# Data-Store & Continual-Learning Architecture

How the agentic SLS system stores, links, retrieves, and learns from print data.
Circled numbers (①–⑪) mark implementation steps; phases at the bottom.

## Design decisions

- **Postgres is the working memory.** Every agent lookup is a SQL query against one
  database. Data *originates* in three places (the recorder, the printer firmware,
  the test lab) but is *queried* in one.
- **Structured query tools, not embedding RAG.** The corpus is dozens of highly
  structured records (builds, profiles, specimens), not thousands of documents.
  Filterable tools whose schemas teach the agent what exists beat vector search at
  this scale. pgvector columns (`events.embedding`, `frames.embedding`) stay
  reserved for phase-2 frame-similarity and free-text search.
- **The HF repos are the publication layer.** `Inova-Mk1-{Telemetry,Database,ASTM}`
  remain the versioned, shareable artifacts. They are downstream of Postgres (or of
  their own lab/firmware sources), never the agent's query surface.
- **Learning lives in the data layer, not model weights.** Action history, case
  library, playbook, and the GP surrogate grow with each build; any harness/model
  plugged in inherits all of it — required by the harness-comparison methodology.

## A. Data plane — where data originates, lives, and gets published

```
  ORIGINS                              POSTGRES — "working memory"           PUBLICATION
  ───────                              ──────────────────────────            ───────────
  Inova Mk1 printer
   └ .NET plugin :5001 ── live ──▶   RECORDING (exists today)
      state / position / plotter       builds  ⊕ inova_session_id ①
      frames · session UUID ②          telemetry · position_hf · frames
                                       events · plotter_commands              export.py
                                                                          ┌──▶ data/exports/
  Firmware storage                   REFERENCE (new, synced copies) ③     │      │
   .s4a jobs · profiles  ── sync ──▶   jobs · print_profiles              │      ▼
   PrintSessions/                      print_sessions · astm_specimens ───┘   HF repos:
                                       (registry = SQL joins across ↑)         Inova-Mk1-Telemetry
  Lab (TestWorks)                                                              Inova-Mk1-Database
   D638 / D790 results ── sync ──▶   DERIVED (new)                             Inova-Mk1-ASTM
                                       build_summaries ④ ◀─ summarizer job     (registry fields
  Curated documents                    agent_actions ⑥                          flow into exports)
   TDS · Fuse1↔Inova translation       agent_sessions · reflections ⑦
   note · papers ─▶ knowledge/ ⑤       embeddings (pgvector, later ⑩)
```

Source-of-truth rule: ASTM and firmware-side rows in Postgres are **synced copies**
— corrections happen at the origin (lab files, firmware) and re-sync, never by
editing Postgres directly. Only the recording family is native to Postgres.

## B. Agent plane — one MCP server, four harnesses, three tool families

```
   HARNESSES                     MCP SERVER (plugin package)              BACKENDS
   ─────────                 ┌──────────────────────────────────┐
   Claude Code ──┐           │ CONTROL (exists)                 │
   OpenCode ─────┤ identical │   printer_status · recoater_*   ─┼─────▶ plugin :5001 (write)
   Codex ────────┤ tools     │   layer_overrides_*              │
   Antigravity ──┘     ────▶ │ KNOWLEDGE (new)                  │
                             │   data_* ⑧  · reference_* ⑤     ─┼─────▶ Postgres (read-only)
                             │ MODELS (later)                   │        + knowledge/ docs
                             │   predict_* · suggest_* ⑨       ─┼─────▶ GP surrogate
                             └───────────────┬──────────────────┘
                                             └── every *_set call logged ──▶ agent_actions ⑥
   INJECTED CONTEXT (not tools):  AGENTS.md ground rules  +  PLAYBOOK.md ⑦ (distilled heuristics)
```

- `data_*`: `builds_list`, `build_get`, `astm_query`, `telemetry_summary`, guarded
  read-only `db_query`. Failed builds are first-class (outcome/failure-mode fields).
- `reference_*`: `reference_list` (index) + `reference_get(id)` over the curated
  `knowledge/` corpus — TDS sheets, manufacturer (Fuse 1) settings, the
  Fuse 1 ↔ Inova translation note (spec comparison + energy-density normalization),
  papers. Tools rather than MCP resources: resource support is uneven across
  harnesses, and tool-call uniformity is what the comparison needs.
- The MCP server is the shared choke point: identical tools for the harness
  comparison, and the harness-agnostic place to log every consequential agent
  action (`agent_actions`), timestamped onto the telemetry timeline.
- Rule of thumb: knowledge the agent *always* needs is injected context
  (AGENTS.md / PLAYBOOK.md); knowledge it *sometimes* needs is a tool.

## C. Learning loop — how each build makes the system smarter

```
        ┌────────────────────────── next build's parameters ◀────────────────────────┐
        ▼                                                                             │
   PRINT RUN ──▶ agent actions ⑥ + telemetry ──▶ BUILD CARD ④ ──▶ ASTM outcomes ③    │
        │                (events timeline)            │                 │             │
        │                                             ▼                 ▼             │
        │                              post-session REFLECTION ⑦   GP SURROGATE ⑨ ───┘
        │                                (case library, from            (refit as
        │                                 action log, not               outcomes accrue)
        │                                 agent self-report)
        │                                             │
        ▼                                             ▼
   vision watchdog ⑪ (later) ──▶ events    PLAYBOOK distillation ⑦ ──▶ injected context
   (camera+thermal+position →              (human-gated promotion)      for every future
    exclusion / recoat suggestions)                                     session
```

Three session artifacts, captured at different layers:

1. **Agent actions** — logged server-side in the MCP server at call time (source of
   truth is what the printer received, not what a transcript claims).
2. **Raw transcripts** — archived per harness with metadata rows in
   `agent_sessions` (session id, harness, model, build_id, transcript path). These
   are the harness-comparison experimental data. Never injected raw into future
   sessions.
3. **Reflection records** — the distilled retrieval unit: situation, hypothesis,
   actions (from the action log), outcome, lesson, pointer to raw transcript.

Guard rails: reflections derive "what was done" from `agent_actions`, not the
agent's narrative of itself; playbook promotion is human-reviewed — a wrong lesson
in always-injected context poisons every future session until noticed.

## Identity & linkage (the registry)

The recorder mints integer `build_id`s; the firmware mints PrintSession UUIDs
(which carry `JobId` and `ProfileId`); the lab keys specimens by batch label with
`job_id`/`print_profile_id` FKs. The bridge is `builds.inova_session_id` ①:

- **Backfill (historical builds):** `scripts/match_build_sessions.py` matches
  builds → sessions by timestamp overlap, writes candidates + evidence into
  `data/exports/build_to_inova_session.csv` for human review, then `--apply`
  imports verified UUIDs into Postgres. After that, the CSV is a generated
  convenience view, not an input.
- **Live (new builds):** the plugin exposes the active PrintSession UUID ②; the
  recorder stamps it onto the `builds` row at print start. No hand-mapping again.

## Implementation phases

| Phase | Steps | What gets built |
|---|---|---|
| **1. Linkage** | ① ② | `builds.inova_session_id` + timestamp-match backfill (CSV as review artifact); plugin exposes live session UUID, recorder stamps it |
| **2. Knowledge base** | ③ ④ | Sync scripts for jobs/profiles/sessions/ASTM into Postgres; telemetry summarizer job → `build_summaries` |
| **3. Tools** | ⑧ ⑤ ⑥ | `data_*` query tools; `knowledge/` corpus + `reference_*` tools (incl. the Fuse1↔Inova translation note); `agent_actions` logging in the MCP server (do early — collects from day one) |
| **4. Learning loop** | ⑦ ⑨ | Reflection records + transcript harvest + playbook w/ human review gate; GP surrogate + `predict_*`/`suggest_*` |
| **5. Later** | ⑩ ⑪ | pgvector embeddings (frame similarity, free-text search); background vision watchdog feeding `events` |
