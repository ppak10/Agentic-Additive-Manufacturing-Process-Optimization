// Normalized conversation store — the harness-agnostic record of every
// agent conversation, message by message.
//
// Levels: agent_conversations (one per chat / headless run — the future
// HuggingFace dataset row) → agent_sessions (per-turn stats; pre-existing
// table, gains conversation_id) → agent_messages (ordered events: user,
// context, assistant, tool_call, tool_result, meta).
//
// Raw transcripts on disk stay the ground truth; these tables are the
// queryable/exportable layer. The same parser feeds the live SSE stream
// (harness/server.ts), the one-shot runner, and the backfill — one
// normalization path for all of them.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Where raw transcripts live. Preferred home is the Agentic-SLS-Conversations
// dataset repo's source/sessions/ (written directly — the dataset repo is
// the archive; commit it often, since until pushed the working tree is the
// only copy). The dataset is a submodule at datasets/Agentic-SLS-Conversations.
// AGENT_SESSIONS_DIR overrides; falls back to the repo-local data/sessions/
// when the submodule checkout is absent (fresh machine, CI).
const DATASET_SESSIONS = path.resolve(
  REPO, "datasets", "Agentic-SLS-Conversations", "source", "sessions",
);

export function sessionsRoot(): string {
  if (process.env.AGENT_SESSIONS_DIR) return process.env.AGENT_SESSIONS_DIR;
  if (existsSync(path.dirname(DATASET_SESSIONS))) return DATASET_SESSIONS;
  return path.join(REPO, "data", "sessions");
}

// Resolve a stored transcript_path (new style: "<name>" or "<name>/turn-N";
// legacy style prefixed with "data/sessions/") to an absolute directory,
// checking both roots. Null if missing or escaping.
export function resolveTranscriptDir(stored: string): string | null {
  const rel = stored.replace(/^data\/sessions\//, "");
  if (!rel || rel.split("/").some((p) => !p || p.startsWith("."))) return null;
  for (const root of [sessionsRoot(), path.join(REPO, "data", "sessions")]) {
    const dir = path.join(root, rel);
    if (dir.startsWith(root + path.sep) && existsSync(dir)) return dir;
  }
  return null;
}

// Write-time secret redaction for raw transcript files: transcripts land
// directly in a publishable dataset working tree, so DSN-shaped strings
// must never reach disk. Redact (not abort) — a marker beats losing the
// transcript.
export function redactSecrets(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED-DSN]");
}

export const STORE_DDL = `
CREATE TABLE IF NOT EXISTS agent_conversations (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  harness         TEXT NOT NULL,
  model           TEXT,
  role            TEXT NOT NULL,
  build_id        BIGINT,
  cli_session_id  TEXT,
  context         JSONB,
  transcript_dir  TEXT
);

-- The analyst/operator preset concept was removed 2026-07-18 (every chat
-- gets the full tool surface); drop the column on existing databases.
ALTER TABLE agent_conversations DROP COLUMN IF EXISTS preset;

CREATE TABLE IF NOT EXISTS agent_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL
                    REFERENCES agent_conversations(id) ON DELETE CASCADE,
  turn            INT NOT NULL,
  seq             INT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,
  content         TEXT,
  tool_name       TEXT,
  tool_input      JSONB,
  is_error        BOOLEAN,
  UNIQUE (conversation_id, turn, seq)
);
CREATE INDEX IF NOT EXISTS agent_messages_conv_idx
  ON agent_messages (conversation_id, turn, seq);

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS conversation_id BIGINT;

-- Panel mode (wiki/Panel-Mode.md; applied live 2026-07-16). Candidates are
-- ordinary one-turn conversations linked to their panel via parent_id/
-- parent_turn; agent_selections carries the preference labels; meta on
-- agent_messages carries event/build references for data turns.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES agent_conversations(id);
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS parent_turn INT;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS meta JSONB;

-- Dev/test flag (2026-07-18): debug conversations are excluded from the
-- Conversations dataset export (and any future learning-loop consumer) —
-- filter with WHERE NOT debug. Settable at creation (GUI draft page) or
-- toggled later via PATCH /agent/conversations/:id.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS debug BOOLEAN NOT NULL DEFAULT false;

-- One conversation spans many builds (user decision 2026-07-16): the
-- association is one-to-many via this join table, populated as builds
-- start/end while the conversation is open. build_id has no FK on purpose
-- (matches agent_conversations.build_id; restores may recreate builds).
CREATE TABLE IF NOT EXISTS conversation_builds (
  conversation_id BIGINT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  build_id        BIGINT NOT NULL,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, build_id)
);

-- Agent-curated artifact panel (2026-07-19). DISTINCT from conversation_builds:
-- that table auto-records every build a conversation *spanned* (panel trackBuild
-- + registry telemetry); this one is the deliberate working set the AGENT pins
-- for the operator's right-hand panel via the artifact_* MCP tools. An artifact
-- may be pinned without ever running here (referencing an old job/profile), and
-- a build may span the chat without being pinned. artifact_id is TEXT so one
-- column holds both numeric build ids and job/profile UUIDs. provenance marks
-- whether the agent *created* it in this conversation (auto-attached on
-- job_create_from_template) or merely *referenced* an existing one.
CREATE TABLE IF NOT EXISTS conversation_artifacts (
  conversation_id BIGINT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  artifact_type   TEXT NOT NULL,                       -- 'build' | 'job' | 'profile'
  artifact_id     TEXT NOT NULL,
  provenance      TEXT NOT NULL DEFAULT 'referenced',  -- 'created' | 'referenced'
  attached_by     TEXT NOT NULL DEFAULT 'agent',       -- 'agent' | 'operator'
  note            TEXT,
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, artifact_type, artifact_id)
);
CREATE INDEX IF NOT EXISTS conversation_artifacts_conv_idx
  ON conversation_artifacts (conversation_id, attached_at);

CREATE TABLE IF NOT EXISTS agent_selections (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   BIGINT NOT NULL REFERENCES agent_conversations(id),
  turn              INT NOT NULL,
  outcome           TEXT NOT NULL,      -- chosen | tie | none | user_authored
  chosen_id         BIGINT REFERENCES agent_conversations(id),
  user_text         TEXT,               -- outcome='user_authored': the gold answer
  candidate_ids     BIGINT[] NOT NULL,
  shown_order       JSONB NOT NULL,     -- slot (A-D) -> candidate id
  stimulus_event_id BIGINT,             -- events.id this turn responded to
  reason            TEXT,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, turn)
);

-- Pointwise feedback layer (2026-07-19) — the SFT/instruction-tuning counterpart
-- to agent_selections' pairwise preferences. A polymorphic annotation over the
-- things worth rating: a model RESPONSE (target_kind='response', target_id=turn
-- number), and later an LLM action (agent_actions.id) or an operator action
-- (events.id). The rich training context (conversation slice, frame/temp/defect
-- window) is NOT stored here — it's reconstructed downstream by (build_id, ts)
-- join; this row is the pointer + the human signal. The correction column is
-- the gold "what should have happened instead" (stronger than a bare thumbs-down).
-- Curated like defect_labels: status active|rejected gates export.
CREATE TABLE IF NOT EXISTS feedback (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,                            -- 'operator' for GUI ratings
  conversation_id BIGINT REFERENCES agent_conversations(id) ON DELETE CASCADE,
  target_kind     TEXT NOT NULL,                   -- 'response' | 'agent_action' | 'operator_event'
  target_id       TEXT NOT NULL,                   -- turn number / agent_actions.id / events.id
  rating          TEXT,                            -- up|down (responses) · correct|ignored|incorrect|demonstration (actions)
  correction      TEXT,                            -- gold: what should have happened instead
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | rejected
  UNIQUE (conversation_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS feedback_conv_idx ON feedback (conversation_id);

-- Build-scoped defect alerts (2026-07-19) — the shared, durable notification a
-- conversation subscribes to by attaching its build as an artifact. ONE row per
-- defect_detection event (event_id UNIQUE): every conversation with this build
-- attached renders the SAME row, so status is shared by construction —
-- addressing it in one conversation marks it addressed in all of them. The
-- snapshot is self-contained (frozen chamber frame ref + temps + objects +
-- defect maps) so the read-only chamber card in a conversation never has to
-- re-join telemetry, even though the values also live in the raw telemetry.
CREATE TABLE IF NOT EXISTS build_alerts (
  id                           BIGSERIAL PRIMARY KEY,
  event_id                     BIGINT UNIQUE,                -- defect_detection events.id
  build_id                     BIGINT,
  ts                           TIMESTAMPTZ NOT NULL,
  layer                        INT,
  z2                           DOUBLE PRECISION,
  alerts                       TEXT[],
  alert_key                    TEXT,                         -- sorted alert classes, the dedup key
  scores                       JSONB,
  snapshot                     JSONB,                        -- { input_frame, maps_png, objects }
  status                       TEXT NOT NULL DEFAULT 'new',  -- new | addressed | dismissed
  addressed_by_conversation_id BIGINT,
  addressed_at                 TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS build_alerts_build_idx ON build_alerts (build_id, id DESC);
-- Added after the table shipped, so an explicit ALTER (CREATE TABLE IF NOT
-- EXISTS won't backfill a column on an existing table). Must precede the
-- partial index below, which references it.
ALTER TABLE build_alerts ADD COLUMN IF NOT EXISTS alert_key TEXT;
-- Dedup to one alert per condition EPISODE, not one per layer: while an alert
-- for this (build, class-set) is still open (status='new'), the same condition
-- recurring each layer collapses onto it (INSERT … ON CONFLICT DO NOTHING).
-- Once addressed/dismissed the predicate no longer covers it, so a later
-- recurrence opens a fresh episode. Raw per-layer model outputs still live in
-- events for training — build_alerts is the notification/curation layer.
CREATE UNIQUE INDEX IF NOT EXISTS build_alerts_open_episode_idx
  ON build_alerts (build_id, alert_key) WHERE status = 'new';

-- Per-conversation defect-notification mute (the breadcrumb bell/silence). When
-- true the conversation does not surface new build alerts, so a noisy build
-- doesn't pester every conversation that has it attached.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS alerts_muted BOOLEAN NOT NULL DEFAULT false;
`;

// Normalized event — same shape the broker streams to the browser.
export interface AgentEvent {
  type: "text" | "tool" | "tool_result" | "done" | "error";
  text?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

export interface TurnStats {
  cliSessionId: string | null;
  model: string | null;
  toolCalls: number;
  tokensIn: number | null;
  tokensOut: number | null;
  finalText: string | null;
}

export function emptyTurnStats(): TurnStats {
  return {
    cliSessionId: null,
    model: null,
    toolCalls: 0,
    tokensIn: null,
    tokensOut: null,
    finalText: null,
  };
}

// Parse one structured transcript line (already JSON.parsed) from a
// harness, emitting normalized events and folding stats. Returns true if
// the line was recognized (used to detect plain-text harnesses).
export function parseHarnessLine(
  harness: string,
  ev: Record<string, any>,
  emit: (e: AgentEvent) => void,
  stats: TurnStats,
): boolean {
  if (harness === "claude") {
    if (ev.type === "system" && ev.session_id) stats.cliSessionId = ev.session_id;
    if (ev.type === "assistant") {
      stats.model ??= ev.message?.model ?? null;
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          emit({ type: "text", text: block.text });
        }
        if (block.type === "tool_use") {
          stats.toolCalls += 1;
          emit({ type: "tool", name: block.name, input: block.input });
        }
      }
    }
    if (ev.type === "user") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_result") {
          const text = Array.isArray(block.content)
            ? block.content.map((c: any) => c.text ?? "").join("")
            : String(block.content ?? "");
          emit({ type: "tool_result", text: text.slice(0, 4000) });
        }
      }
    }
    if (ev.type === "result") {
      stats.cliSessionId = ev.session_id ?? stats.cliSessionId;
      stats.tokensIn = ev.usage?.input_tokens ?? null;
      stats.tokensOut = ev.usage?.output_tokens ?? null;
      stats.finalText = typeof ev.result === "string" ? ev.result : null;
    }
    return true;
  }

  if (harness === "codex") {
    if (ev.type === "thread.started" && ev.thread_id) {
      stats.cliSessionId = ev.thread_id;
    }
    const item = ev.item ?? {};
    if (ev.type === "item.started" && item.type === "mcp_tool_call") {
      stats.toolCalls += 1;
      emit({ type: "tool", name: item.tool, input: item.arguments });
    }
    if (ev.type === "item.completed" && item.type === "mcp_tool_call") {
      const r = item.error
        ? `error: ${item.error.message}`
        : JSON.stringify(item.result)?.slice(0, 4000);
      emit({ type: "tool_result", text: r ?? "" });
    }
    if (ev.type === "item.completed" && item.type === "agent_message") {
      stats.finalText = item.text ?? stats.finalText;
      emit({ type: "text", text: item.text ?? "" });
    }
    if (ev.type === "turn.completed" && ev.usage) {
      stats.tokensIn = ev.usage.input_tokens ?? null;
      stats.tokensOut = ev.usage.output_tokens ?? null;
    }
    return true;
  }

  return false; // opencode / agy: plain text, no structured lines
}

// Batch-parse a whole stdout transcript (backfill + one-shot runner path).
export function parseTranscript(
  harness: string,
  stdout: string,
): { events: AgentEvent[]; stats: TurnStats } {
  const events: AgentEvent[] = [];
  const stats = emptyTurnStats();
  let sawStructured = false;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (parseHarnessLine(harness, ev, (e) => events.push(e), stats)) {
      sawStructured = true;
    }
  }
  if (!sawStructured && stdout.trim()) {
    stats.finalText = stdout.trim();
    events.push({ type: "text", text: stats.finalText });
  }
  return { events, stats };
}

// ---------------------------------------------------------------------------

export async function ensureStoreSchema(pool: pg.Pool): Promise<void> {
  await pool.query(STORE_DDL);
}

export async function createConversation(
  pool: pg.Pool,
  meta: {
    harness: string;
    role: string;
    buildId?: number | null;
    context?: unknown;
    transcriptDir?: string | null;
    createdAt?: Date;
    debug?: boolean;
  },
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO agent_conversations
       (created_at, harness, role, build_id, context, transcript_dir, debug)
     VALUES (coalesce($1, now()), $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      meta.createdAt ?? null,
      meta.harness,
      meta.role,
      meta.buildId ?? null,
      meta.context ? JSON.stringify(meta.context) : null,
      meta.transcriptDir ?? null,
      meta.debug ?? false,
    ],
  );
  return rows[0].id;
}

// Persist one turn: the user message (+ optional context line) followed by
// the normalized events, in order. Skips 'done' (stats live on the
// agent_sessions row) but keeps 'error'.
export async function insertTurnMessages(
  pool: pg.Pool,
  conversationId: number,
  turn: number,
  userMessage: string,
  context: string | undefined,
  events: AgentEvent[],
  // The artifact the operator had focused in the panel when they sent this
  // turn (token "type:id", from the URL's ?artifact= param). Pinned onto the
  // user message's meta so exported transcripts carry the on-screen context
  // the message was written against — the same value the MCP artifact_list
  // tool sees live via AGENTIC_FOCUS. Absent when nothing was focused.
  focus?: string,
): Promise<void> {
  let seq = 0;
  const add = (
    kind: string,
    content: string | null,
    toolName?: string | null,
    toolInput?: unknown,
    isError?: boolean,
    meta?: unknown,
  ) =>
    pool.query(
      `INSERT INTO agent_messages
         (conversation_id, turn, seq, kind, content, tool_name, tool_input,
          is_error, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (conversation_id, turn, seq) DO NOTHING`,
      [
        conversationId,
        turn,
        seq++,
        kind,
        content,
        toolName ?? null,
        toolInput !== undefined ? JSON.stringify(toolInput) : null,
        isError ?? null,
        meta !== undefined ? JSON.stringify(meta) : null,
      ],
    );

  if (context) await add("context", context);
  await add("user", userMessage, null, undefined, undefined, focus ? { focus } : undefined);
  for (const e of events) {
    if (e.type === "text") await add("assistant", e.text ?? "");
    else if (e.type === "tool") await add("tool_call", null, e.name, e.input);
    else if (e.type === "tool_result") await add("tool_result", e.text ?? "");
    else if (e.type === "error") {
      await add("meta", String(e.message ?? "error"), null, undefined, true);
    }
  }
}

export async function finalizeConversation(
  pool: pg.Pool,
  conversationId: number,
  stats: { model: string | null; cliSessionId: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE agent_conversations
     SET model = coalesce(model, $2), cli_session_id = coalesce($3, cli_session_id)
     WHERE id = $1`,
    [conversationId, stats.model, stats.cliSessionId],
  );
}
