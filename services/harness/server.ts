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
// Presets: 'analyst' (default) restricts Claude to read-only tools via
// --allowedTools; codex/opencode/agy have all-or-nothing permission flags,
// so for them analyst is enforced by prompt instruction only (documented
// limitation). 'operator' grants the full tool surface — the GUI gates it
// behind an explicit confirmation.
//
// Usage: npx tsx harness/server.ts   (PORT via AGENT_BROKER_PORT, default 3100)
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
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
type Preset = "analyst" | "operator";

interface Chat {
  id: string;
  harness: Harness;
  preset: Preset;
  cliSessionId: string | null;
  conversationId: number | null;
  dir: string;
  turn: number;
  busy: boolean;
}

const chats = new Map<string, Chat>();

const READ_TOOLS = [
  "printer_status",
  "recoater_passes_get",
  "recoater_full_passes_get",
  "layer_overrides_get",
  "builds_list",
  "build_get",
  "astm_query",
  "telemetry_summary",
  "db_query",
  "reference_list",
  "reference_get",
].map((t) => `mcp__agentic-sls__${t}`);

const ANALYST_NOTE =
  "(Session preset: ANALYST — you may use read/query tools but must NOT " +
  "call any *_set tool or modify printer state.)";

// SSE event sent to the browser — same shape the store persists.
type Ev = AgentEvent;

interface TurnResult extends TurnStats {
  exitCode: number;
}

function buildCmd(chat: Chat, message: string): string[] {
  const resume = chat.cliSessionId;
  switch (chat.harness) {
    case "claude": {
      const tools =
        chat.preset === "operator" ? "mcp__agentic-sls" : READ_TOOLS.join(",");
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
        tools,
        // allowedTools ADDS to Claude's built-ins; analyst must also deny
        // the ones that could reach the printer or filesystem sideways
        // (Bash can curl the plugin API directly).
        ...(chat.preset === "analyst"
          ? ["--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch"]
          : []),
      ];
    }
    case "codex": {
      const base = resume
        ? ["codex", "exec", "resume", resume, message]
        : ["codex", "exec", message];
      // MCP calls are auto-cancelled in exec mode without the bypass
      // (openai/codex#16685) — all-or-nothing, so analyst is prompt-level.
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
): Promise<{ res: TurnResult; stdout: string; stderr: string }> {
  const cmd = buildCmd(chat, message);
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: PLUGINS_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

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
      `chat:${chat.preset}`,
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

app.post<{ Body: { harness: Harness; preset?: Preset } }>(
  "/agent/chats",
  async (req, reply) => {
    const { harness, preset } = req.body ?? ({} as any);
    if (!["claude", "opencode", "codex", "agy"].includes(harness)) {
      return reply.code(400).send({ error: "unknown harness" });
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const chat: Chat = {
      id,
      harness,
      preset: preset === "operator" ? "operator" : "analyst",
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
        preset: chat.preset,
        transcriptDir: path.basename(chat.dir),
      });
    }
    chats.set(id, chat);
    return { chatId: id, harness: chat.harness, preset: chat.preset };
  },
);

app.post<{ Params: { id: string }; Body: { message: string; context?: string } }>(
  "/agent/chats/:id/messages",
  async (req, reply) => {
    const chat = chats.get(req.params.id);
    if (!chat) return reply.code(404).send({ error: "unknown chat" });
    if (chat.busy) return reply.code(409).send({ error: "turn in progress" });
    const { message, context } = req.body ?? ({} as any);
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
    if (chat.preset === "analyst") parts.push(ANALYST_NOTE);
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
  },
);

// Session history — also serves the GUI's Agents page, so it needs no
// recorder-side wiring at all.
app.get("/agent/sessions", async (_req, reply) => {
  if (!pool) return reply.code(503).send({ error: "DATABASE_URL not set" });
  try {
    const { rows } = await pool.query(
      `SELECT id, started_at, ended_at, harness, model, role, build_id,
              tool_calls, turns, tokens_in, tokens_out, exit_code,
              left(prompt, 200) AS prompt, left(result, 300) AS result
       FROM agent_sessions ORDER BY id DESC LIMIT 200`,
    );
    return rows;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
});

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

await app.listen({ port: PORT, host: "127.0.0.1" });
console.error(`agent broker on :${PORT} (db: ${pool ? "yes" : "NO"})`);
