// Server-side agent action log — the harness-agnostic record of every
// consequential thing an agent does to the printer. Logged here, at the MCP
// choke point all four harnesses share, so the source of truth is what the
// printer was told, not what a transcript claims. Rows land on the same
// timeline as telemetry (join by ts / build_id).
//
// Logging is strictly fire-and-forget: printer control must never block on,
// or fail because of, the database. No DATABASE_URL → one stderr notice,
// then silence.
import pg from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS agent_actions (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  build_id   BIGINT,
  harness    TEXT,
  tool       TEXT NOT NULL,
  arguments  JSONB,
  result     JSONB,
  is_error   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS agent_actions_ts_idx ON agent_actions (ts DESC);
CREATE INDEX IF NOT EXISTS agent_actions_build_ts_idx
  ON agent_actions (build_id, ts DESC);
`;

// Separate from db.ts's pool on purpose: that one forces read-only
// transactions for the knowledge tools; this one must insert.
let writePool: pg.Pool | null = null;
let ready: Promise<void> | null = null;
let warned = false;

function getWritePool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!warned) {
      console.error("agent_actions logging disabled (DATABASE_URL not set)");
      warned = true;
    }
    return null;
  }
  if (!writePool) {
    writePool = new pg.Pool({
      connectionString: url,
      max: 1,
      options: "-c statement_timeout=5000",
    });
    ready = writePool.query(DDL).then(() => undefined);
  }
  return writePool;
}

// For tests and graceful shutdown; the stdio server normally just exits.
export async function closeActionLog(): Promise<void> {
  if (writePool) {
    await writePool.end();
    writePool = null;
    ready = null;
  }
}

export function truncateForLog(value: unknown, maxChars = 4000): unknown {
  const s = JSON.stringify(value);
  if (s === undefined || s.length <= maxChars) return value;
  return { truncated: true, prefix: s.slice(0, maxChars) };
}

export async function logAction(
  server: McpServer,
  tool: string,
  args: unknown,
  result: CallToolResult,
): Promise<void> {
  const pool = getWritePool();
  if (!pool) return;
  await ready;
  const harness = server.server.getClientVersion()?.name ?? null;
  const text = (result.content?.[0] as { text?: string } | undefined)?.text;
  let parsed: unknown = text;
  try {
    parsed = text === undefined ? null : JSON.parse(text);
  } catch {
    // keep raw text
  }
  await pool.query(
    `INSERT INTO agent_actions (build_id, harness, tool, arguments, result,
                                is_error)
     VALUES ((SELECT id FROM builds WHERE ended_at IS NULL
              ORDER BY id DESC LIMIT 1),
             $1, $2, $3, $4, $5)`,
    [
      harness,
      tool,
      JSON.stringify(truncateForLog(args)),
      JSON.stringify(truncateForLog(parsed)),
      !!result.isError,
    ],
  );
}

// Wrap a set-tool handler so its calls are logged. Errors in logging are
// reported to stderr and swallowed — the tool result always goes back to
// the agent unchanged.
export function withActionLog<A>(
  server: McpServer,
  tool: string,
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const result = await handler(args);
    logAction(server, tool, args, result).catch((err) =>
      console.error(`agent_actions log failed for ${tool}:`, err?.message),
    );
    return result;
  };
}
