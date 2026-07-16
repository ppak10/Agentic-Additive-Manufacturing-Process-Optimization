// Backfill agent_conversations/agent_messages for sessions recorded before
// the message-level store existed, by re-parsing their archived transcripts
// through the same normalization path (store.parseTranscript).
//
// Chat turns share a conversation (grouped by their parent
// …-chat-<harness> directory); one-shot runs get one conversation each.
// Idempotent: only touches agent_sessions rows with conversation_id NULL.
//
// Usage: npx tsx harness/backfill.ts
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createConversation,
  ensureStoreSchema,
  finalizeConversation,
  insertTurnMessages,
  parseTranscript,
} from "./store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const envFile = path.join(REPO, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
await ensureStoreSchema(pool);

const { rows } = await pool.query(
  `SELECT * FROM agent_sessions WHERE conversation_id IS NULL ORDER BY id`,
);
console.error(`backfill: ${rows.length} sessions without conversations`);

// Conversation key: chat turns live in <chat-dir>/turn-N — group by parent.
const convByKey = new Map<string, number>();

for (const s of rows) {
  const rel: string = s.transcript_path ?? "";
  const isChatTurn = /-chat-[^/]+\/turn-\d+$/.test(rel);
  const key = isChatTurn ? path.dirname(rel) : rel;

  let conversationId = convByKey.get(key);
  if (conversationId === undefined) {
    conversationId = await createConversation(pool, {
      harness: s.harness,
      role: isChatTurn ? "chat" : s.role,
      preset: s.role?.startsWith("chat:") ? s.role.slice(5) : null,
      buildId: s.build_id,
      transcriptDir: key,
      createdAt: s.started_at,
    });
    convByKey.set(key, conversationId);
  }

  const stdoutPath = path.join(REPO, rel, "stdout.jsonl");
  let events: ReturnType<typeof parseTranscript>["events"] = [];
  let model: string | null = s.model;
  let cliSessionId: string | null = null;
  if (existsSync(stdoutPath)) {
    const parsed = parseTranscript(s.harness, readFileSync(stdoutPath, "utf8"));
    events = parsed.events;
    model = model ?? parsed.stats.model;
    cliSessionId = parsed.stats.cliSessionId;
  } else {
    console.error(`  session ${s.id}: transcript missing (${rel}) — stats-only`);
  }

  const turn = isChatTurn
    ? Number(rel.match(/turn-(\d+)$/)?.[1] ?? 1)
    : 1;
  await insertTurnMessages(
    pool, conversationId, turn, s.prompt ?? "", undefined, events,
  );
  await finalizeConversation(pool, conversationId, { model, cliSessionId });
  await pool.query(
    "UPDATE agent_sessions SET conversation_id = $1 WHERE id = $2",
    [conversationId, s.id],
  );
  console.error(
    `  session ${s.id} (${s.harness}/${s.role}) → conversation ${conversationId} turn ${turn}, ${events.length} messages`,
  );
}

await pool.end();
console.error("backfill done");
