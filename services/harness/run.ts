// Harness session runner — the uniform driver over the four agent CLIs.
//
// Spawns a headless session, archives the raw transcript (directly into
// the Agentic-SLS-Conversations dataset repo's source/sessions/ — see
// sessionsRoot in store.ts), and records a normalized row in agent_sessions
// (harness, model, role, build_id, tool calls, tokens, duration). This is
// both the orchestration entry point (watchdog / reflector triggers call
// it) and the thesis instrumentation (one row per session, joinable with
// agent_actions on harness + time).
//
// Usage:
//   npx tsx harness/run.ts <claude|opencode|codex|agy> \
//     --prompt "..." [--role adhoc] [--build 12] [--model m] [--dry-run]
//
// Auth is per-CLI and interactive (claude/opencode/codex login, agy first
// run) — this runner assumes it has been done and fails fast otherwise.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createConversation,
  ensureStoreSchema,
  finalizeConversation,
  insertTurnMessages,
  parseTranscript,
  redactSecrets,
  sessionsRoot,
} from "./store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Harness project root: the CLIs run with services/plugins/ as cwd so each
// harness's native project discovery (.mcp.json, .claude-plugin,
// .opencode/, gemini-extension.json) anchors on the plugin surface, not
// the dev repo.
const PLUGINS_ROOT = path.join(REPO, "services", "plugins");

const DDL = `
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

interface RunStats {
  model: string | null;
  toolCalls: number;
  turns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  result: string | null;
}

interface Driver {
  cmd: (prompt: string, model?: string) => string[];
  // Parse the raw stdout transcript into normalized stats.
  parse: (stdout: string) => RunStats;
}

const emptyStats = (): RunStats => ({
  model: null,
  toolCalls: 0,
  turns: null,
  tokensIn: null,
  tokensOut: null,
  result: null,
});

function jsonLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial line */
    }
  }
  return out;
}

const DRIVERS: Record<string, Driver> = {
  claude: {
    cmd: (prompt, model) => [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      ".mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__agentic-sls",
      ...(model ? ["--model", model] : []),
    ],
    parse: (stdout) => {
      const s = emptyStats();
      for (const ev of jsonLines(stdout) as Array<Record<string, any>>) {
        if (ev.type === "assistant") {
          s.model ??= ev.message?.model ?? null;
          for (const block of ev.message?.content ?? []) {
            if (block.type === "tool_use") s.toolCalls += 1;
          }
        }
        if (ev.type === "result") {
          s.turns = ev.num_turns ?? null;
          s.tokensIn = ev.usage?.input_tokens ?? null;
          s.tokensOut = ev.usage?.output_tokens ?? null;
          s.result = typeof ev.result === "string" ? ev.result : null;
        }
      }
      return s;
    },
  },

  opencode: {
    // opencode MUST get an explicit model: its free zen default errors
    // upstream (2026-07-16) and thesis rows need the model recorded anyway.
    cmd: (prompt, model) => [
      "opencode",
      "run",
      prompt,
      "--print-logs",
      "--model",
      model ?? process.env.OPENCODE_MODEL ?? "opencode/deepseek-v4-flash-free",
    ],
    parse: (stdout) => {
      const s = emptyStats();
      // opencode run emits plain text; tool calls appear in --print-logs
      // stderr, which we archive but don't parse yet. Result = full text.
      s.result = stdout.trim().slice(-2000) || null;
      return s;
    },
  },

  codex: {
    // codex exec auto-cancels every MCP tool call (approval reader gets EOF
    // — openai/codex#16685); the only working workaround is the bypass flag,
    // which also disables shell sandboxing. Acceptable while roles are
    // observe-only; revisit before any autonomous set-tool role.
    cmd: (prompt, model) => [
      "codex",
      "exec",
      prompt,
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      ...(model ? ["--model", model] : []),
    ],
    parse: (stdout) => {
      const s = emptyStats();
      for (const ev of jsonLines(stdout) as Array<Record<string, any>>) {
        const item = ev.item ?? {};
        if (ev.type === "item.completed" && item.type === "mcp_tool_call") {
          s.toolCalls += 1;
        }
        if (ev.type === "item.completed" && item.type === "agent_message") {
          s.result = item.text ?? s.result;
        }
        if (ev.type === "turn.completed" && ev.usage) {
          s.tokensIn = (s.tokensIn ?? 0) + (ev.usage.input_tokens ?? 0);
          s.tokensOut = (s.tokensOut ?? 0) + (ev.usage.output_tokens ?? 0);
        }
        s.model ??= ev.model ?? null;
      }
      return s;
    },
  },

  agy: {
    // Antigravity CLI (gemini-cli successor). --print = non-interactive;
    // tool permission prompts can't render there, so headless runs need
    // --dangerously-skip-permissions — acceptable while roles are
    // observe-only, revisit before granting set-tools autonomy. MCP comes
    // from .agents/mcp_config.json in the workspace.
    cmd: (prompt, model) => [
      "agy",
      "--print",
      prompt,
      "--dangerously-skip-permissions",
      ...(model ? ["--model", model] : []),
    ],
    parse: (stdout) => {
      const s = emptyStats();
      s.result = stdout.trim().slice(-2000) || null;
      return s;
    },
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const harness = process.argv[2];
  const driver = DRIVERS[harness];
  const prompt = arg("prompt");
  if (!driver || !prompt) {
    console.error(
      "usage: tsx harness/run.ts <claude|opencode|codex|agy> --prompt '...' " +
        "[--role adhoc] [--build N] [--model m] [--dry-run]",
    );
    return 1;
  }
  const role = arg("role") ?? "adhoc";
  const buildId = arg("build") ? Number(arg("build")) : null;
  const model = arg("model");

  const cmd = driver.cmd(prompt, model);
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify(cmd));
    return 0;
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = path.join(sessionsRoot(), `${stamp}-${harness}`);
  mkdirSync(dir, { recursive: true });

  console.error(`[harness] ${cmd.join(" ").slice(0, 160)}`);
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: PLUGINS_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    process.stderr.write(".");
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exitCode: number = await new Promise((res) => child.on("close", res));
  const endedAt = new Date();
  process.stderr.write("\n");

  writeFileSync(path.join(dir, "stdout.jsonl"), redactSecrets(stdout));
  writeFileSync(path.join(dir, "stderr.log"), redactSecrets(stderr));
  const stats = driver.parse(stdout);
  // Normalized message-level record (agent_conversations/agent_messages) —
  // same parser and tables the chat broker uses.
  const parsed = parseTranscript(harness, stdout);
  // ...stats FIRST: it carries its own `model` (parsed from the stream,
  // null for plain-text harnesses) which must NOT overwrite an explicit
  // --model. This exact overwrite bug is why opencode/agy session rows
  // recorded model=null even when a model was passed (found by the first
  // harness typecheck, 2026-07-16).
  const meta = {
    ...stats,
    harness,
    role,
    build_id: buildId,
    model: model ?? stats.model,
    prompt,
    cmd,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    exit_code: exitCode,
  };
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  if (process.env.DATABASE_URL) {
    const dbPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await dbPool.query(DDL);
      await ensureStoreSchema(dbPool);
      const conversationId = await createConversation(dbPool, {
        harness,
        role,
        buildId,
        transcriptDir: path.basename(dir),
        createdAt: startedAt,
      });
      await insertTurnMessages(
        dbPool, conversationId, 1, prompt, undefined, parsed.events,
      );
      await finalizeConversation(dbPool, conversationId, {
        model: meta.model ?? parsed.stats.model,
        cliSessionId: parsed.stats.cliSessionId,
      });
      await dbPool.query(
        `INSERT INTO agent_sessions (started_at, ended_at, harness, model,
           role, build_id, prompt, transcript_path, tool_calls, turns,
           tokens_in, tokens_out, exit_code, result, conversation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          startedAt,
          endedAt,
          harness,
          meta.model,
          role,
          buildId,
          prompt,
          path.basename(dir),
          stats.toolCalls,
          stats.turns,
          stats.tokensIn,
          stats.tokensOut,
          exitCode,
          stats.result?.slice(0, 4000) ?? null,
          conversationId,
        ],
      );
    } finally {
      await dbPool.end();
    }
  } else {
    console.error("[harness] DATABASE_URL not set — session row skipped");
  }

  console.error(
    `[harness] ${harness} exit=${exitCode} tools=${stats.toolCalls} ` +
      `tokens=${stats.tokensIn ?? "?"}/${stats.tokensOut ?? "?"} → ${dir}`,
  );
  if (stats.result) console.log(stats.result);
  return exitCode === 0 ? 0 : 1;
}

process.exit(await main());
