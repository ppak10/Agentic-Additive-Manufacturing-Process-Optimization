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
  preset          TEXT,
  build_id        BIGINT,
  cli_session_id  TEXT,
  context         JSONB,
  transcript_dir  TEXT
);

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
    preset?: string | null;
    buildId?: number | null;
    context?: unknown;
    transcriptDir?: string | null;
    createdAt?: Date;
  },
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO agent_conversations
       (created_at, harness, role, preset, build_id, context, transcript_dir)
     VALUES (coalesce($1, now()), $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      meta.createdAt ?? null,
      meta.harness,
      meta.role,
      meta.preset ?? null,
      meta.buildId ?? null,
      meta.context ? JSON.stringify(meta.context) : null,
      meta.transcriptDir ?? null,
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
): Promise<void> {
  let seq = 0;
  const add = (
    kind: string,
    content: string | null,
    toolName?: string | null,
    toolInput?: unknown,
    isError?: boolean,
  ) =>
    pool.query(
      `INSERT INTO agent_messages
         (conversation_id, turn, seq, kind, content, tool_name, tool_input,
          is_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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
      ],
    );

  if (context) await add("context", context);
  await add("user", userMessage);
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
