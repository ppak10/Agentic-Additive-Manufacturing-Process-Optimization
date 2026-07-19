import pg from "pg";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { jsonResult } from "./result.js";

// Human-in-the-loop approval gate for mutating tools — the harness-agnostic
// analogue of Claude Code's approve/decline. It lives at the MCP choke point
// because all four CLIs run with their native permission prompts bypassed for
// headless operation, so this is the only place a uniform gate can sit (and
// the same place agent_actions logging lives).
//
// Per-conversation MODE (agent_conversation_settings.approval_mode):
//   ask  — mutating tools block for an operator decision (default)
//   auto — execute without asking
//   plan — refuse mutating tools (read / explore only)
//
// The conversation is identified by AGENTIC_CONVERSATION_ID, injected by the
// broker when it spawns a chat turn. With no conversation id or no
// DATABASE_URL (one-shot runs, panel candidates, tests) the gate is OFF —
// behaviour is unchanged.

export type ApprovalMode = "ask" | "auto" | "plan";

const POLL_MS = 1000;
const TIMEOUT_MS = 90_000;

const DDL = `
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

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;
let warned = false;

function getPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!warned) {
      console.error("approval gate disabled (DATABASE_URL not set)");
      warned = true;
    }
    return null;
  }
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 1, options: "-c statement_timeout=5000" });
    ready = pool.query(DDL).then(() => undefined);
  }
  return pool;
}

function conversationId(): number | null {
  const raw = process.env.AGENTIC_CONVERSATION_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getMode(p: pg.Pool, convId: number): Promise<ApprovalMode> {
  const { rows } = await p.query<{ approval_mode: string }>(
    "SELECT approval_mode FROM agent_conversation_settings WHERE conversation_id = $1",
    [convId],
  );
  const m = rows[0]?.approval_mode;
  return m === "auto" || m === "plan" ? m : "ask";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function refusal(mode: ApprovalMode, reason: string): CallToolResult {
  return jsonResult({
    status: mode === "plan" ? "refused" : "declined",
    mode,
    reason,
    message:
      mode === "plan"
        ? "Read-only (plan) mode is active — mutating printer actions are disabled. " +
          "Describe what you would do instead and let the operator switch modes."
        : "The operator declined this action; it was NOT performed. " +
          "Do not retry without new instruction.",
  });
}

// Wrap a mutating-tool handler so it must clear the conversation's approval
// gate before it runs. Composed inside withActionLog, so agent_actions records
// the final outcome (executed, declined, or refused).
export function withApproval<A>(
  tool: string,
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const convId = conversationId();
    if (convId == null) return handler(args); // no gate outside a conversation
    const p = getPool();
    if (!p) return handler(args); // no DATABASE_URL → can't gate
    await ready;

    let mode: ApprovalMode;
    try {
      mode = await getMode(p, convId);
    } catch {
      mode = "ask"; // fail safe: gate rather than silently execute
    }
    if (mode === "auto") return handler(args);
    if (mode === "plan") return refusal("plan", "plan mode active");

    // ask: file a pending request and wait for the operator's decision
    let id: number;
    try {
      const { rows } = await p.query<{ id: string }>(
        `INSERT INTO agent_approvals (conversation_id, tool, arguments)
         VALUES ($1, $2, $3) RETURNING id`,
        [convId, tool, JSON.stringify(args ?? {})],
      );
      id = Number(rows[0]!.id);
    } catch (err) {
      return refusal("ask", `could not record approval request: ${(err as Error).message}`);
    }

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      await sleep(POLL_MS);
      let status = "pending";
      let reason: string | null = null;
      try {
        const { rows } = await p.query<{ status: string; reason: string | null }>(
          "SELECT status, reason FROM agent_approvals WHERE id = $1",
          [id],
        );
        status = rows[0]?.status ?? "pending";
        reason = rows[0]?.reason ?? null;
      } catch {
        /* transient DB blip — keep waiting */
      }
      if (status === "approved") return handler(args);
      if (status === "declined") return refusal("ask", reason ?? "operator declined");
      if (Date.now() >= deadline) {
        await p
          .query(
            `UPDATE agent_approvals SET status = 'declined', reason = 'timeout',
               decided_at = now() WHERE id = $1 AND status = 'pending'`,
            [id],
          )
          .catch(() => {});
        return refusal("ask", "no operator response within 90s (auto-declined)");
      }
    }
  };
}
