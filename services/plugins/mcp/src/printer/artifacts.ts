import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pg from "pg";
import type { InovaClient } from "../client.js";
import { errorResult, jsonResult } from "../result.js";

// Artifact-panel curation tools — the agent's control over the conversation's
// right-hand "things of concern" panel in the GUI. DISTINCT from creating or
// printing anything: attaching an artifact just pins an existing job / build /
// print profile so the operator sees it while they talk. The agent curates the
// panel so the operator doesn't have to.
//
// Scoped to the conversation via AGENTIC_CONVERSATION_ID (the same env the
// broker injects for the approval gate). Outside a conversation (one-shot runs,
// panel candidates, tests) these are graceful no-ops — there is no panel to
// curate. Rows live in conversation_artifacts (DDL mirrored from
// services/harness/store.ts; whichever process runs first wins).
//
// The panel's *focused* tab travels the same way state does: the broker puts
// the operator's on-screen selection in AGENTIC_FOCUS ("type:id") per turn, so
// artifact_list can report "the operator is looking at this right now" without
// any per-click database write.

export type ArtifactType = "build" | "job" | "profile" | "powder_tuning";
const ARTIFACT_TYPES = ["build", "job", "profile", "powder_tuning"] as const;

// powder_tuning is a singleton view (the live tuning session), not a reference
// to a stored entity — its id is always the constant below so add/remove/focus
// agree on one row per conversation.
export const POWDER_TUNING_ARTIFACT_ID = "session";

const DDL = `
CREATE TABLE IF NOT EXISTS conversation_artifacts (
  conversation_id BIGINT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  artifact_type   TEXT NOT NULL,
  artifact_id     TEXT NOT NULL,
  provenance      TEXT NOT NULL DEFAULT 'referenced',
  attached_by     TEXT NOT NULL DEFAULT 'agent',
  note            TEXT,
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, artifact_type, artifact_id)
);
CREATE INDEX IF NOT EXISTS conversation_artifacts_conv_idx
  ON conversation_artifacts (conversation_id, attached_at);
`;

// Separate write pool from db.ts (which forces read-only for the knowledge
// tools). Lazy + fire-safe: no DATABASE_URL → one stderr notice, then the
// tools report they cannot reach the panel store.
let writePool: pg.Pool | null = null;
let ready: Promise<void> | null = null;
let warned = false;

function getWritePool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!warned) {
      console.error("artifact panel disabled (DATABASE_URL not set)");
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

export async function closeArtifactStore(): Promise<void> {
  if (writePool) {
    await writePool.end();
    writePool = null;
    ready = null;
  }
}

function conversationId(): number | null {
  const raw = process.env.AGENTIC_CONVERSATION_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Debug-conversation naming: content created from a debug-flagged
// conversation (agent_conversations.debug) carries a "[DEBUG] " name prefix
// so the operator can find and delete it later. Enforced HERE at the MCP
// chokepoint — creation tools call debugName() on every name they persist —
// so no harness can forget the convention. Cached per process (one MCP
// server per turn; the flag doesn't flip mid-turn).
export const DEBUG_MARK = "[DEBUG]";
let debugFlag: Promise<boolean> | null = null;

export function isDebugConversation(): Promise<boolean> {
  if (debugFlag) return debugFlag;
  debugFlag = (async () => {
    const convId = conversationId();
    const pool = convId != null ? getWritePool() : null;
    if (convId == null || !pool) return false;
    await ready;
    try {
      const { rows } = await pool.query<{ debug: boolean }>(
        "SELECT debug FROM agent_conversations WHERE id = $1",
        [convId],
      );
      return rows[0]?.debug === true;
    } catch {
      return false; // unknown → don't mangle names
    }
  })();
  return debugFlag;
}

// Apply the debug prefix to a to-be-created name (no-op outside a debug
// conversation; never double-prefixes).
export async function debugName(name: string): Promise<string> {
  if (!(await isDebugConversation())) return name;
  return name.startsWith(DEBUG_MARK) ? name : `${DEBUG_MARK} ${name}`;
}

// Parse the operator's focused tab ("type:id") from AGENTIC_FOCUS. Only ids
// without a colon are expected (build numbers, UUIDs), so split on the first.
function focusedArtifact(): { type: string; id: string } | null {
  const raw = process.env.AGENTIC_FOCUS;
  if (!raw) return null;
  // singleton tabs travel as a bare token (no ":id")
  if (raw === "powder_tuning")
    return { type: "powder_tuning", id: POWDER_TUNING_ARTIFACT_ID };
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const type = raw.slice(0, i);
  const id = raw.slice(i + 1);
  return type && id ? { type, id } : null;
}

// Attach (upsert) an artifact to a conversation's panel. Exported so the
// creation tools (e.g. job_create_from_template) can auto-pin their output
// with provenance='created'. Fire-and-forget for those callers: a panel write
// must never fail the actual printer/job operation.
export async function attachArtifact(
  convId: number,
  type: ArtifactType,
  id: string,
  provenance: "created" | "referenced" = "referenced",
  note?: string,
): Promise<void> {
  const pool = getWritePool();
  if (!pool) return;
  await ready;
  await pool.query(
    `INSERT INTO conversation_artifacts
       (conversation_id, artifact_type, artifact_id, provenance, attached_by, note)
     VALUES ($1, $2, $3, $4, 'agent', $5)
     ON CONFLICT (conversation_id, artifact_type, artifact_id)
     DO UPDATE SET note = COALESCE(EXCLUDED.note, conversation_artifacts.note)`,
    [convId, type, id, provenance, note ?? null],
  );
}

// Confirm an existing artifact id before pinning it — a dangling tab helps no
// one. Jobs/profiles are validated live against the firmware (a job the agent
// just created isn't in the synced reference tables yet); builds against the
// recorder's builds table. Returns a human message on failure, null on ok.
async function validate(
  client: InovaClient,
  pool: pg.Pool,
  type: ArtifactType,
  id: string,
): Promise<string | null> {
  try {
    if (type === "job") {
      await client.getBare(`/jobs/${id}`);
      return null;
    }
    if (type === "profile") {
      const profiles = await client.getBare<{ id: string }[]>("/profiles");
      return profiles.some((p) => p.id === id)
        ? null
        : `no print profile with id ${id} on the printer`;
    }
    if (type === "powder_tuning") return null; // singleton — nothing to look up
    // build
    if (!/^\d+$/.test(id)) return `build id must be numeric, got "${id}"`;
    const { rows } = await pool.query("SELECT 1 FROM builds WHERE id = $1", [id]);
    return rows[0] ? null : `no build ${id} in the recorder`;
  } catch (err) {
    return `could not verify ${type} ${id}: ${(err as Error).message}`;
  }
}

export function registerPrinterArtifacts(server: McpServer, client: InovaClient) {
  server.registerTool(
    "artifact_add",
    {
      title: "Pin an artifact to the conversation panel",
      description:
        "Attach an existing job, build, or print profile to THIS conversation's " +
        "right-hand artifact panel so the operator can see what you're discussing. " +
        "Attaching does NOT create or print anything — it only references something " +
        "that already exists (use it to pull up an old build, a candidate profile, " +
        "or a job you just created). The id is validated against the printer/" +
        "recorder before it's pinned. type=powder_tuning pins the live powder-" +
        "tuning session view (patch grid + chamber); its id is ignored — pass " +
        "\"session\". Use artifact_list to see what's already there " +
        "and artifact_remove to clear one. No-op outside an interactive conversation.",
      inputSchema: {
        type: z.enum(ARTIFACT_TYPES).describe("Artifact kind to pin."),
        id: z
          .string()
          .min(1)
          .describe(
            "job/profile UUID or numeric build id (validated live); \"session\" for powder_tuning.",
          ),
        note: z
          .string()
          .optional()
          .describe("Optional short reason this is on the panel (shown as a hint)."),
      },
    },
    async ({ type, id, note }) => {
      if (type === "powder_tuning") id = POWDER_TUNING_ARTIFACT_ID;
      const convId = conversationId();
      if (convId == null) {
        return jsonResult({
          status: "noop",
          message:
            "Not inside an interactive conversation — there is no artifact panel " +
            "to pin to. Nothing was changed.",
        });
      }
      const pool = getWritePool();
      if (!pool) return errorResult(new Error("artifact panel store unavailable (no DATABASE_URL)"));
      await ready;
      const problem = await validate(client, pool, type, id);
      if (problem) return errorResult(new Error(problem));
      try {
        await attachArtifact(convId, type, id, "referenced", note);
        return jsonResult({ status: "attached", type, id, conversation_id: convId });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "artifact_remove",
    {
      title: "Remove an artifact from the conversation panel",
      description:
        "Detach a job, build, or print profile from THIS conversation's artifact " +
        "panel. Only removes the panel tab — it never deletes the underlying job/" +
        "build/profile. Use it to keep the panel focused on what's currently " +
        "relevant as the conversation moves on. No-op outside a conversation.",
      inputSchema: {
        type: z.enum(ARTIFACT_TYPES).describe("Artifact kind to unpin."),
        id: z.string().min(1).describe("The pinned artifact's id."),
      },
    },
    async ({ type, id }) => {
      if (type === "powder_tuning") id = POWDER_TUNING_ARTIFACT_ID;
      const convId = conversationId();
      if (convId == null) {
        return jsonResult({ status: "noop", message: "Not inside a conversation." });
      }
      const pool = getWritePool();
      if (!pool) return errorResult(new Error("artifact panel store unavailable (no DATABASE_URL)"));
      await ready;
      try {
        const { rowCount } = await pool.query(
          `DELETE FROM conversation_artifacts
           WHERE conversation_id = $1 AND artifact_type = $2 AND artifact_id = $3`,
          [convId, type, id],
        );
        return jsonResult({ status: rowCount ? "removed" : "not_pinned", type, id });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "artifact_list",
    {
      title: "List the conversation's pinned artifacts",
      description:
        "Show what's currently on THIS conversation's artifact panel (the jobs, " +
        "builds, and print profiles you and the operator have pinned), plus which " +
        "one the operator is looking at right now (the `focused` field). Call this " +
        "before add/remove to curate deliberately, or to see what the operator has " +
        "on screen. Returns an empty list outside an interactive conversation.",
      inputSchema: {},
    },
    async () => {
      const convId = conversationId();
      if (convId == null) {
        return jsonResult({ artifacts: [], focused: null, in_conversation: false });
      }
      const pool = getWritePool();
      if (!pool) return errorResult(new Error("artifact panel store unavailable (no DATABASE_URL)"));
      await ready;
      try {
        const { rows } = await pool.query(
          `SELECT artifact_type AS type, artifact_id AS id, provenance, attached_by,
                  note, attached_at
           FROM conversation_artifacts WHERE conversation_id = $1
           ORDER BY attached_at, artifact_type, artifact_id`,
          [convId],
        );
        return jsonResult({
          artifacts: rows,
          focused: focusedArtifact(),
          in_conversation: true,
          conversation_id: convId,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
