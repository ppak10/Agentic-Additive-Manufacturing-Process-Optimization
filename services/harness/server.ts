// Agent session broker — the backend for the GUI's Copilot-style panel.
//
// Deliberately a separate process from the recorder: chats must survive
// recorder restarts, a leaking chat must never take recording down, and
// keeping it out of server/src means we can iterate on it while a print is
// live (tsx watch on the recorder hot-reloads; this service is independent).
//
// One chat = one CLI conversation, advanced turn-by-turn: each message
// spawns the harness CLI headlessly, resuming its native session, and the
// turn's events stream to the browser as SSE. Every turn is also recorded
// exactly like a headless run: transcript under data/sessions/ + a row in
// agent_sessions (role 'chat') — GUI chats are thesis data too.
//
// Every chat gets the full MCP tool surface (the knowledge tools are
// read-only by construction and *_set calls are logged to agent_actions
// server-side). The analyst/operator preset split was removed 2026-07-18 —
// reintroduce deliberately if tool gating is ever needed again.
//
// Usage: npx tsx harness/server.ts   (PORT via AGENT_BROKER_PORT, default 3100)
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { registerPanelRoutes, type Harness as PanelHarness } from "./panel.js";
import {
  type AgentEvent,
  type TurnStats,
  createConversation,
  emptyTurnStats,
  ensureStoreSchema,
  finalizeConversation,
  insertTurnMessages,
  parseHarnessLine,
  redactSecrets,
  resolveTranscriptDir,
  sessionsRoot,
} from "./store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGINS_ROOT = path.join(REPO, "services", "plugins");
const PORT = Number(process.env.AGENT_BROKER_PORT ?? 3100);

// Load repo .env (DATABASE_URL etc.) the same way launch-local.cjs does.
const envFile = path.join(REPO, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  : null;

const SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  harness         TEXT NOT NULL,
  model           TEXT,
  role            TEXT NOT NULL,
  build_id        BIGINT,
  prompt          TEXT,
  transcript_path TEXT,
  tool_calls      INT,
  turns           INT,
  tokens_in       BIGINT,
  tokens_out      BIGINT,
  exit_code       INT,
  result          TEXT
);
CREATE INDEX IF NOT EXISTS agent_sessions_started_idx
  ON agent_sessions (started_at DESC);
`;

type Harness = "claude" | "opencode" | "codex" | "agy";

interface Chat {
  id: string;
  harness: Harness;
  cliSessionId: string | null;
  conversationId: number | null;
  dir: string;
  turn: number;
  busy: boolean;
}

const chats = new Map<string, Chat>();

// SSE event sent to the browser — same shape the store persists.
type Ev = AgentEvent;

interface TurnResult extends TurnStats {
  exitCode: number;
}

function buildCmd(chat: Chat, message: string): string[] {
  const resume = chat.cliSessionId;
  switch (chat.harness) {
    case "claude": {
      return [
        "claude",
        "-p",
        message,
        ...(resume ? ["--resume", resume] : []),
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        ".mcp.json",
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__agentic-sls",
      ];
    }
    case "codex": {
      const base = resume
        ? ["codex", "exec", "resume", resume, message]
        : ["codex", "exec", message];
      // MCP calls are auto-cancelled in exec mode without the bypass
      // (openai/codex#16685).
      return [...base, "--json", "--dangerously-bypass-approvals-and-sandbox"];
    }
    case "opencode":
      return [
        "opencode",
        "run",
        message,
        ...(resume ? ["--session", resume] : []),
        "--print-logs",
        // Explicit model required — zen default errors upstream (2026-07-16)
        "--model",
        process.env.OPENCODE_MODEL ?? "opencode/deepseek-v4-flash-free",
      ];
    case "agy":
      return [
        "agy",
        "-p",
        message,
        // Conversation id isn't emitted in print mode; -c continues the
        // most recent conversation. `busy` serializes turns per chat, but
        // two concurrent agy chats could cross-talk — v1 limitation.
        ...(resume ? ["-c"] : []),
        "--dangerously-skip-permissions",
      ];
  }
}

function runTurn(
  chat: Chat,
  message: string,
  emit: (ev: Ev) => void,
  timeoutMs?: number,
): Promise<{ res: TurnResult; stdout: string; stderr: string }> {
  const cmd = buildCmd(chat, message);
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: PLUGINS_ROOT,
    // Scope the MCP approval gate to this conversation (read by
    // services/plugins/mcp approvals.ts). Absent for conversation-less chats,
    // so their mutating tools run ungated as before.
    env: {
      ...process.env,
      ...(chat.conversationId != null
        ? { AGENTIC_CONVERSATION_ID: String(chat.conversationId) }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Panel candidates run four CLIs in parallel — a hung one must not wedge
  // the whole turn. SIGKILL surfaces as a normal close (exitCode null → -1).
  const killer = timeoutMs
    ? setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    : null;

  const res: TurnResult = { ...emptyTurnStats(), exitCode: -1 };
  res.cliSessionId = chat.cliSessionId;
  let stdout = "";
  let stderr = "";
  let buf = "";
  let sawStructured = false;

  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    if (parseHarnessLine(chat.harness, ev, emit, res)) sawStructured = true;
  };

  child.stdout.on("data", (d: Buffer) => {
    stdout += d;
    buf += d;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d;
    if (chat.harness === "opencode" && res.cliSessionId === null) {
      const m = String(d).match(/\b(ses_[A-Za-z0-9]+)\b/);
      if (m) res.cliSessionId = m[1];
    }
  });

  return new Promise((resolve) => {
    child.on("close", (code) => {
      if (killer) clearTimeout(killer);
      res.exitCode = code ?? -1;
      // Plain-text harnesses (opencode, agy): whole stdout is the reply.
      if (!sawStructured && stdout.trim()) {
        res.finalText = stdout.trim();
        emit({ type: "text", text: res.finalText });
      }
      resolve({ res, stdout, stderr });
    });
  });
}

async function recordTurn(
  chat: Chat,
  message: string,
  startedAt: Date,
  r: { res: TurnResult; stdout: string; stderr: string },
): Promise<void> {
  const turnDir = path.join(chat.dir, `turn-${chat.turn}`);
  mkdirSync(turnDir, { recursive: true });
  writeFileSync(path.join(turnDir, "stdout.jsonl"), redactSecrets(r.stdout));
  writeFileSync(path.join(turnDir, "stderr.log"), redactSecrets(r.stderr));
  if (!pool) return;
  await pool.query(SESSIONS_DDL);
  await ensureStoreSchema(pool);
  await pool.query(
    `INSERT INTO agent_sessions (started_at, ended_at, harness, model, role,
       build_id, prompt, transcript_path, tool_calls, turns, tokens_in,
       tokens_out, exit_code, result, conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      startedAt,
      new Date(),
      chat.harness,
      r.res.model,
      "chat",
      null,
      message.slice(0, 4000),
      path.join(path.basename(chat.dir), `turn-${chat.turn}`),
      r.res.toolCalls,
      chat.turn,
      r.res.tokensIn,
      r.res.tokensOut,
      r.res.exitCode,
      r.res.finalText?.slice(0, 4000) ?? null,
      chat.conversationId,
    ],
  );
}

// (transcript_path values are relative to sessionsRoot(); see store.ts)

// ---------------------------------------------------------------------------

const app = Fastify({ logger: false });

app.get("/agent/health", async () => ({
  ok: true,
  chats: chats.size,
  db: !!pool,
}));

// ---------------------------------------------------------------------------
// Harness status: the auth panel's probe. Reports per-CLI binary version
// (pinned in the broker image) + the last recorded session outcome from
// agent_sessions (the honest "is this harness working" signal) + the guided
// login command for OAuth flows (v1: run via docker exec; a pty relay that
// captures the paste-URL flow into the GUI is the planned v2).

const HARNESSES: Harness[] = ["claude", "opencode", "codex", "agy"];

const LOGIN_HINTS: Record<Harness, string> = {
  claude: "docker exec -it agentic-sls-broker claude /login",
  opencode: "docker exec -it agentic-sls-broker opencode auth login",
  codex: "docker exec -it agentic-sls-broker codex login",
  agy: "docker exec -it agentic-sls-broker agy login",
};

function cliVersion(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 5000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0 ? out.trim().split("\n")[0].slice(0, 60) : null);
    });
  });
}

app.get("/agent/harness/status", async () => {
  const versions = await Promise.all(HARNESSES.map((h) => cliVersion(h)));
  let last: Record<string, { started_at: string; exit_code: number | null; model: string | null }> = {};
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (harness) harness, started_at, exit_code, model
         FROM agent_sessions ORDER BY harness, started_at DESC`);
      last = Object.fromEntries(rows.map((r) => [r.harness, r]));
    } catch { /* table may not exist yet */ }
  }
  return HARNESSES.map((h, i) => ({
    harness: h,
    installed: versions[i] !== null,
    version: versions[i],
    lastSession: last[h] ?? null,
    loginHint: LOGIN_HINTS[h],
  }));
});

app.post<{ Body: { harness: Harness; debug?: boolean } }>(
  "/agent/chats",
  async (req, reply) => {
    const { harness, debug } = req.body ?? ({} as any);
    if (!["claude", "opencode", "codex", "agy"].includes(harness)) {
      return reply.code(400).send({ error: "unknown harness" });
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const chat: Chat = {
      id,
      harness,
      cliSessionId: null,
      conversationId: null,
      dir: path.join(sessionsRoot(), `${stamp}-chat-${harness}`),
      turn: 0,
      busy: false,
    };
    mkdirSync(chat.dir, { recursive: true });
    if (pool) {
      await ensureStoreSchema(pool);
      chat.conversationId = await createConversation(pool, {
        harness: chat.harness,
        role: "chat",
        transcriptDir: path.basename(chat.dir),
        debug: debug === true,
      });
    }
    chats.set(id, chat);
    return {
      chatId: id,
      conversationId: chat.conversationId,
      harness: chat.harness,
    };
  },
);

// One chat turn streamed as SSE — shared by the chatId- and
// conversationId-keyed routes.
async function streamChatTurn(
  chat: Chat,
  body: { message?: string; context?: string } | undefined,
  reply: import("fastify").FastifyReply,
) {
  if (chat.busy) return reply.code(409).send({ error: "turn in progress" });
  const { message, context } = body ?? {};
  if (!message?.trim()) return reply.code(400).send({ error: "empty message" });

  chat.busy = true;
  chat.turn += 1;
  const startedAt = new Date();

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const events: Ev[] = [];
  const emit = (ev: Ev) => {
    reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.type !== "done") events.push(ev);
  };

  const parts = [];
  if (context) parts.push(`[context] ${context}`);
  parts.push(message);
  const fullMessage = parts.join("\n\n");

  try {
    const r = await runTurn(chat, fullMessage, emit);
    chat.cliSessionId = r.res.cliSessionId;
    await recordTurn(chat, message, startedAt, r).catch((err) =>
      console.error("recordTurn failed:", err?.message),
    );
    if (pool && chat.conversationId != null) {
      await insertTurnMessages(
        pool, chat.conversationId, chat.turn, message, context, events,
      ).catch((err) => console.error("insertTurnMessages failed:", err?.message));
      await finalizeConversation(pool, chat.conversationId, {
        model: r.res.model,
        cliSessionId: r.res.cliSessionId,
      }).catch(() => {});
    }
    emit({
      type: "done",
      exitCode: r.res.exitCode,
      toolCalls: r.res.toolCalls,
      tokensIn: r.res.tokensIn,
      tokensOut: r.res.tokensOut,
      turn: chat.turn,
    });
  } catch (err) {
    emit({ type: "error", message: String((err as Error)?.message ?? err) });
  } finally {
    chat.busy = false;
    reply.raw.end();
  }
  return reply;
}

app.post<{ Params: { id: string }; Body: { message: string; context?: string } }>(
  "/agent/chats/:id/messages",
  async (req, reply) => {
    const chat = chats.get(req.params.id);
    if (!chat) return reply.code(404).send({ error: "unknown chat" });
    return streamChatTurn(chat, req.body, reply);
  },
);

// Conversation-keyed messaging — what the GUI's interactive conversation
// page uses. Chats live in memory; if the broker restarted since the chat
// was created, rehydrate one from the conversation row (harness,
// cli_session_id, transcript dir, turn counter) and resume the CLI's
// native session. agy caveat: continuation is `-c` (most recent), so a
// rehydrated agy chat can cross-talk with a newer one — known v1 limit.
async function chatForConversation(convId: number): Promise<Chat | "gone" | null> {
  for (const c of chats.values()) if (c.conversationId === convId) return c;
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT harness, cli_session_id, transcript_dir
     FROM agent_conversations WHERE id = $1 AND role = 'chat'`,
    [convId],
  );
  if (!rows[0]) return "gone";
  const { rows: t } = await pool.query(
    `SELECT coalesce(max(turn), 0) AS turn FROM agent_messages WHERE conversation_id = $1`,
    [convId],
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const chat: Chat = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    harness: rows[0].harness as Harness,
    cliSessionId: rows[0].cli_session_id ?? null,
    conversationId: convId,
    dir: path.join(
      sessionsRoot(),
      rows[0].transcript_dir ?? `${stamp}-chat-${rows[0].harness}`,
    ),
    turn: Number(t[0].turn),
    busy: false,
  };
  mkdirSync(chat.dir, { recursive: true });
  chats.set(chat.id, chat);
  return chat;
}

app.post<{ Params: { id: string }; Body: { message: string; context?: string } }>(
  "/agent/conversations/:id/messages",
  async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
    const convId = Number(req.params.id);
    if (!Number.isFinite(convId)) return reply.code(400).send({ error: "bad id" });
    const chat = await chatForConversation(convId);
    if (chat === "gone" || chat === null) {
      return reply.code(404).send({ error: `no chat conversation ${convId}` });
    }
    return streamChatTurn(chat, req.body, reply);
  },
);

// Conversation history — the sidebar's ChatGPT-style recents list and the
// conversation viewer page. Candidates are internal (panel plumbing), so
// they're excluded from the list but readable by id.
app.get<{ Querystring: { limit?: string } }>("/agent/conversations", async (req, reply) => {
  if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
  const limit = Math.min(50, Number(req.query.limit) || 20);
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.created_at, c.harness, c.role, c.model, c.debug,
              (SELECT left(m.content, 80) FROM agent_messages m
               WHERE m.conversation_id = c.id AND m.kind IN ('user', 'event')
                 AND m.content IS NOT NULL
               ORDER BY m.turn, m.seq LIMIT 1) AS title,
              (SELECT max(m.ts) FROM agent_messages m
               WHERE m.conversation_id = c.id) AS last_at
       FROM agent_conversations c
       WHERE c.role <> 'panel:candidate'
       ORDER BY coalesce((SELECT max(m.ts) FROM agent_messages m
                          WHERE m.conversation_id = c.id), c.created_at) DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
});

app.get<{ Params: { id: string } }>("/agent/conversations/:id", async (req, reply) => {
  if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
  const id = Number(req.params.id);
  const { rows } = await pool.query(
    `SELECT id, created_at, harness, role, model, build_id, debug
     FROM agent_conversations WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return reply.code(404).send({ error: `no conversation ${id}` });
  const { rows: messages } = await pool.query(
    `SELECT turn, seq, ts, kind, content, tool_name, tool_input, is_error, meta
     FROM agent_messages WHERE conversation_id = $1
     ORDER BY turn, seq LIMIT 3000`,
    [id],
  );
  const { rows: builds } = await pool.query(
    `SELECT build_id FROM conversation_builds WHERE conversation_id = $1 ORDER BY build_id`,
    [id],
  );
  return { conversation: rows[0], messages, builds: builds.map((b) => Number(b.build_id)) };
});

// Toggle the debug flag — debug conversations are excluded from the
// Conversations dataset export (the learning loop). Flipping it also
// covers a panel's candidates (parent_id) so the whole tree stays out.
app.patch<{ Params: { id: string }; Body: { debug?: boolean } }>(
  "/agent/conversations/:id",
  async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
    const id = Number(req.params.id);
    const debug = req.body?.debug;
    if (typeof debug !== "boolean") {
      return reply.code(400).send({ error: "body must set debug: boolean" });
    }
    const { rows } = await pool.query(
      `UPDATE agent_conversations SET debug = $2
       WHERE id = $1 OR parent_id = $1 RETURNING id`,
      [id, debug],
    );
    if (!rows.some((r) => Number(r.id) === id)) {
      return reply.code(404).send({ error: `no conversation ${id}` });
    }
    return { ok: true, debug, updated: rows.length };
  },
);

// ── approval gate (human-in-the-loop for mutating MCP tools) ──
// Mode (ask/auto/plan) is per-conversation; the MCP server reads it and files
// pending rows in agent_approvals while it blocks. The GUI polls the list here,
// decides, and switches modes. DDL mirrors services/plugins/mcp approvals.ts
// (both idempotent — whichever runs first wins).
const APPROVALS_DDL = `
CREATE TABLE IF NOT EXISTS agent_conversation_settings (
  conversation_id BIGINT PRIMARY KEY,
  approval_mode   TEXT NOT NULL DEFAULT 'ask',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_approvals (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  tool            TEXT NOT NULL,
  arguments       JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_approvals_pending_idx
  ON agent_approvals (conversation_id, status);
`;
let approvalsReady: Promise<void> | null = null;
function ensureApprovals(): Promise<void> {
  // callers guard on `pool` before invoking
  return (approvalsReady ??= pool!.query(APPROVALS_DDL).then(() => undefined));
}
const APPROVAL_MODES = new Set(["ask", "auto", "plan"]);

// Pending approvals + current mode for a conversation (the GUI polls this).
app.get<{ Params: { id: string } }>(
  "/agent/conversations/:id/approvals",
  async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad id" });
    await ensureApprovals();
    const { rows: pending } = await pool.query(
      `SELECT id, tool, arguments, created_at FROM agent_approvals
       WHERE conversation_id = $1 AND status = 'pending' ORDER BY id`,
      [id],
    );
    const { rows: s } = await pool.query(
      "SELECT approval_mode FROM agent_conversation_settings WHERE conversation_id = $1",
      [id],
    );
    return { mode: s[0]?.approval_mode ?? "ask", pending };
  },
);

// Decide a pending approval (approve / decline, with an optional reason).
app.post<{ Params: { id: string }; Body: { decision?: string; reason?: string } }>(
  "/agent/approvals/:id",
  async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
    const id = Number(req.params.id);
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "declined") {
      return reply.code(400).send({ error: "decision must be approved|declined" });
    }
    await ensureApprovals();
    const { rows } = await pool.query(
      `UPDATE agent_approvals SET status = $2, reason = $3, decided_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, decision, req.body?.reason ?? null],
    );
    if (!rows[0]) return reply.code(409).send({ error: "already decided or unknown" });
    return { ok: true, id, decision };
  },
);

// Set the conversation's approval mode.
app.post<{ Params: { id: string }; Body: { mode?: string } }>(
  "/agent/conversations/:id/mode",
  async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
    const id = Number(req.params.id);
    const mode = req.body?.mode;
    if (!mode || !APPROVAL_MODES.has(mode)) {
      return reply.code(400).send({ error: "mode must be ask|auto|plan" });
    }
    await ensureApprovals();
    await pool.query(
      `INSERT INTO agent_conversation_settings (conversation_id, approval_mode, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (conversation_id)
       DO UPDATE SET approval_mode = EXCLUDED.approval_mode, updated_at = now()`,
      [id, mode],
    );
    return { ok: true, mode };
  },
);

// Session history — also serves the GUI's Agents page, so it needs no
// recorder-side wiring at all. Cursor-paged: `before` (exclusive id) walks
// older rows for the GUI's infinite scroll; no `before` returns the head.
app.get<{ Querystring: { limit?: string; before?: string } }>(
  "/agent/sessions",
  async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = Number(req.query.before) || null;
    try {
      const { rows } = await pool.query(
        `SELECT id, started_at, ended_at, harness, model, role, build_id,
                tool_calls, turns, tokens_in, tokens_out, exit_code,
                left(prompt, 200) AS prompt, left(result, 300) AS result
         FROM agent_sessions
         WHERE ($1::bigint IS NULL OR id < $1)
         ORDER BY id DESC LIMIT $2`,
        [before, limit],
      );
      return rows;
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") return [];
      throw err;
    }
  },
);

app.get<{ Params: { id: string } }>("/agent/sessions/:id", async (req, reply) => {
  if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM agent_sessions WHERE id = $1", [id]);
  const session = rows[0];
  if (!session) return reply.code(404).send({ error: `no session ${id}` });
  let transcript: string | null = null;
  let stderrLog: string | null = null;
  if (session.transcript_path) {
    const dir = resolveTranscriptDir(session.transcript_path);
    if (dir) {
      try {
        transcript = readFileSync(path.join(dir, "stdout.jsonl"), "utf8").slice(-200_000);
      } catch { /* archived elsewhere or gone */ }
      try {
        stderrLog = readFileSync(path.join(dir, "stderr.log"), "utf8").slice(-20_000);
      } catch { /* ok */ }
    }
  }
  return { session, transcript, stderr: stderrLog };
});

// ---------------------------------------------------------------------------
// Panel mode: fresh one-shots per candidate (no session resume — the
// panel's canonical transcript IS the context), 4-minute kill timeout.
// Advisory-only behavior is enforced by the panel's ADVISOR_HEADER prompt.

registerPanelRoutes(app, {
  pool,
  runOneShot: async (harness: PanelHarness, message: string) => {
    const synthetic: Chat = {
      id: "panel",
      harness,
      cliSessionId: null,
      conversationId: null,
      dir: "",
      turn: 1,
      busy: false,
    };
    const events: Ev[] = [];
    const r = await runTurn(synthetic, message, (ev) => {
      if (ev.type !== "done") events.push(ev);
    }, 240_000);
    return { ...r, events };
  },
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.error(`agent broker on :${PORT} (db: ${pool ? "yes" : "NO"})`);
