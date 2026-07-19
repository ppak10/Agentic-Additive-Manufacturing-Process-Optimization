// Panel mode (wiki/Panel-Mode.md) — broker-owned canonical conversation,
// stateless 4-harness fan-out, blinded A-D selection.
//
// The panel conversation is INDEPENDENT of builds (user decision
// 2026-07-16): it spans builds, with build references tracked per-turn in
// message meta and one-to-many in conversation_builds. Turns arrive from
// two sources: the operator typing, and the event watcher below injecting
// DATA turns for alerting defect_detection events (auto-triggering the
// fan-out — the operator then selects one of the four candidate responses
// or types their own; either way the choice lands in agent_selections).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  createConversation,
  finalizeConversation,
  insertTurnMessages,
  redactSecrets,
  sessionsRoot,
  type AgentEvent,
  type TurnStats,
} from "./store.js";

export type Harness = "claude" | "opencode" | "codex" | "agy";
const ALL_HARNESSES: Harness[] = ["claude", "opencode", "codex", "agy"];
const SLOTS = ["A", "B", "C", "D"] as const;

export interface OneShotResult {
  res: TurnStats & { exitCode: number };
  stdout: string;
  stderr: string;
  events: AgentEvent[];
}

export interface PanelDeps {
  pool: pg.Pool | null;
  // Fresh one-shot on the given harness; must enforce its own timeout.
  runOneShot: (harness: Harness, message: string) => Promise<OneShotResult>;
}

interface Msg {
  role: "operator" | "data" | "advisor" | "note";
  text: string;
  meta?: Record<string, unknown>;
}

interface Candidate {
  slot: string;
  conversationId: number | null;
  harness: Harness;
  model: string | null;
  text: string;
  exitCode: number;
}

interface Panel {
  id: string;
  conversationId: number | null;
  turn: number;
  busy: boolean;
  console: boolean;
  enabled: Harness[];
  transcript: Msg[];
  lastBuildId: number | null;
  pending: {
    turn: number;
    stimulusEventId: number | null;
    candidates: Candidate[];
  } | null;
  lastSelection: {
    turn: number;
    outcome: string;
    revealed: { slot: string; harness: Harness; model: string | null }[];
  } | null;
}

const panels = new Map<string, Panel>();

// ---------------------------------------------------------------------------

const ADVISOR_HEADER =
  "You are one of several advisors on the operator console of an SLS4All " +
  "Inova MK1 SLS printer (Formlabs PA12-family powders). Below is the " +
  "console conversation: OPERATOR messages, DATA turns injected by the " +
  "printer's monitoring systems (defect model alerts, build events), and " +
  "previously selected ADVISOR responses. Write the single best next " +
  "response for the operator: concise, specific to the data, and " +
  "actionable. You may use read/query tools to check telemetry, builds, " +
  "or reference docs before answering. If you recommend a printer action " +
  "(extra recoat pass, part exclusion, temperature change), state exactly " +
  "what and why — the operator executes actions separately; never call " +
  "any *_set tool yourself.";

function renderPrompt(p: Panel): string {
  const lines = [ADVISOR_HEADER, ""];
  for (const m of p.transcript) {
    const tag =
      m.role === "operator" ? "OPERATOR" :
      m.role === "data" ? "DATA" :
      m.role === "advisor" ? "ADVISOR (selected)" : "NOTE";
    lines.push(`${tag}: ${m.text}`, "");
  }
  lines.push("Respond now to the last message above.");
  return lines.join("\n");
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function appendCanonical(
  deps: PanelDeps,
  p: Panel,
  msg: Msg,
  kind: string,
): Promise<void> {
  p.transcript.push(msg);
  if (!deps.pool || p.conversationId == null) return;
  await deps.pool
    .query(
      `INSERT INTO agent_messages (conversation_id, turn, seq, kind, content, meta)
       VALUES ($1, $2,
         coalesce((SELECT max(seq) + 1 FROM agent_messages
                   WHERE conversation_id = $1 AND turn = $2), 0),
         $3, $4, $5)`,
      [p.conversationId, p.turn, kind, msg.text, msg.meta ? JSON.stringify(msg.meta) : null],
    )
    .catch((err) => console.error("panel canonical insert failed:", err?.message));
}

async function trackBuild(deps: PanelDeps, p: Panel, buildId: number | null): Promise<void> {
  if (buildId == null || !deps.pool || p.conversationId == null) return;
  if (p.lastBuildId !== buildId) {
    // build changed under this conversation — annotate the transcript so
    // "which builds did this span" reads out of the messages themselves
    await appendCanonical(deps, p, {
      role: "note",
      text: `— build ${buildId} is now active —`,
      meta: { build_id: buildId },
    }, "meta");
    p.lastBuildId = buildId;
  }
  await deps.pool
    .query(
      `INSERT INTO conversation_builds (conversation_id, build_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [p.conversationId, buildId],
    )
    .catch(() => {});
}

// Fan one turn out to all enabled harnesses. Returns when every candidate
// has finished (each one-shot enforces its own timeout).
async function fanOut(
  deps: PanelDeps,
  p: Panel,
  turnMsg: Msg,
  stimulusEventId: number | null,
): Promise<void> {
  p.busy = true;
  p.turn += 1;
  p.pending = null;
  try {
    await appendCanonical(deps, p, turnMsg, turnMsg.role === "data" ? "event" : "user");
    await trackBuild(deps, p, (turnMsg.meta?.build_id as number | undefined) ?? null);
    const prompt = renderPrompt(p);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const candidates = await Promise.all(
      p.enabled.map(async (harness): Promise<Candidate> => {
        const dirName = `${stamp}-panel${p.conversationId ?? p.id}-turn${p.turn}-${harness}`;
        const dir = path.join(sessionsRoot(), dirName);
        let r: OneShotResult;
        try {
          r = await deps.runOneShot(harness, prompt);
        } catch (err) {
          r = {
            res: { cliSessionId: null, model: null, toolCalls: 0, tokensIn: null,
                   tokensOut: null, finalText: null, exitCode: -1 },
            stdout: "", stderr: String((err as Error)?.message ?? err), events: [],
          };
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, "stdout.jsonl"), redactSecrets(r.stdout));
          writeFileSync(path.join(dir, "stderr.log"), redactSecrets(r.stderr));
        } catch { /* transcript archival is best-effort */ }

        let conversationId: number | null = null;
        if (deps.pool && p.conversationId != null) {
          try {
            conversationId = await createConversation(deps.pool, {
              harness,
              role: "panel:candidate",
              transcriptDir: dirName,
            });
            await deps.pool.query(
              `UPDATE agent_conversations SET parent_id = $2, parent_turn = $3 WHERE id = $1`,
              [conversationId, p.conversationId, p.turn],
            );
            await insertTurnMessages(deps.pool, conversationId, 1, prompt, undefined, r.events);
            await finalizeConversation(deps.pool, conversationId, {
              model: r.res.model,
              cliSessionId: r.res.cliSessionId,
            });
            await deps.pool.query(
              `INSERT INTO agent_sessions (started_at, ended_at, harness, model, role,
                 prompt, transcript_path, tool_calls, turns, tokens_in, tokens_out,
                 exit_code, result, conversation_id)
               VALUES (now(), now(), $1, $2, 'panel:candidate', $3, $4, $5, 1, $6, $7, $8, $9, $10)`,
              [harness, r.res.model, prompt.slice(0, 4000), dirName, r.res.toolCalls,
               r.res.tokensIn, r.res.tokensOut, r.res.exitCode,
               r.res.finalText?.slice(0, 4000) ?? null, conversationId],
            );
          } catch (err) {
            console.error("panel candidate persist failed:", (err as Error)?.message);
          }
        }
        return {
          slot: "",
          conversationId,
          harness,
          model: r.res.model,
          text: r.res.finalText?.trim() || "(no response)",
          exitCode: r.res.exitCode,
        };
      }),
    );

    // blinded assignment: shuffle server-side, then label A-D in shown order
    const order = shuffled(candidates);
    order.forEach((c, i) => { c.slot = SLOTS[i] ?? String(i); });
    p.pending = { turn: p.turn, stimulusEventId, candidates: order };
  } finally {
    p.busy = false;
  }
}

// ---------------------------------------------------------------------------

function publicState(p: Panel) {
  return {
    id: p.id,
    conversationId: p.conversationId,
    turn: p.turn,
    busy: p.busy,
    console: p.console,
    enabled: p.enabled,
    transcript: p.transcript,
    // anonymized until selected: slots + text only
    pending: p.pending
      ? {
          turn: p.pending.turn,
          stimulusEventId: p.pending.stimulusEventId,
          candidates: p.pending.candidates.map((c) => ({ slot: c.slot, text: c.text })),
        }
      : null,
    lastSelection: p.lastSelection,
  };
}

async function createPanel(deps: PanelDeps, opts: { console?: boolean; enabled?: Harness[] }): Promise<Panel> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const p: Panel = {
    id,
    conversationId: null,
    turn: 0,
    busy: false,
    console: !!opts.console,
    enabled: (opts.enabled ?? ALL_HARNESSES).filter((h) => ALL_HARNESSES.includes(h)),
    transcript: [],
    lastBuildId: null,
    pending: null,
    lastSelection: null,
  };
  if (deps.pool) {
    p.conversationId = await createConversation(deps.pool, {
      harness: "panel",
      role: "panel",
      context: { console: p.console, enabled: p.enabled },
    }).catch(() => null as unknown as number);
  }
  panels.set(id, p);
  return p;
}

export function registerPanelRoutes(app: FastifyInstance, deps: PanelDeps): void {
  app.post<{ Body: { console?: boolean; enabled?: Harness[] } }>(
    "/agent/panel",
    async (req) => publicState(await createPanel(deps, req.body ?? {})),
  );

  app.get("/agent/panel", async () => [...panels.values()].map(publicState));

  app.get<{ Params: { id: string } }>("/agent/panel/:id", async (req, reply) => {
    const p = panels.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "unknown panel" });
    return publicState(p);
  });

  // Operator turn — triggers the fan-out. Returns immediately; the GUI
  // polls GET /agent/panel/:id until pending appears (candidates take
  // 15-90 s each; they run in parallel).
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/agent/panel/:id/turn",
    async (req, reply) => {
      const p = panels.get(req.params.id);
      if (!p) return reply.code(404).send({ error: "unknown panel" });
      if (p.busy) return reply.code(409).send({ error: "turn in progress" });
      if (p.pending) return reply.code(409).send({ error: "pending selection — select first" });
      const text = req.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: "empty text" });
      void fanOut(deps, p, { role: "operator", text }, null);
      return { turn: p.turn + 1, busy: true };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { outcome: string; slot?: string; userText?: string; reason?: string };
  }>("/agent/panel/:id/select", async (req, reply) => {
    const p = panels.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "unknown panel" });
    if (!p.pending) return reply.code(409).send({ error: "nothing pending" });
    const { outcome, slot, userText, reason } = req.body ?? ({} as any);
    if (!["chosen", "tie", "none", "user_authored"].includes(outcome)) {
      return reply.code(400).send({ error: "bad outcome" });
    }
    const pending = p.pending;
    const chosen = outcome === "chosen"
      ? pending.candidates.find((c) => c.slot === slot)
      : null;
    if (outcome === "chosen" && !chosen) return reply.code(400).send({ error: "bad slot" });
    if (outcome === "user_authored" && !userText?.trim()) {
      return reply.code(400).send({ error: "userText required" });
    }

    if (deps.pool && p.conversationId != null) {
      await deps.pool
        .query(
          `INSERT INTO agent_selections
             (conversation_id, turn, outcome, chosen_id, user_text,
              candidate_ids, shown_order, stimulus_event_id, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (conversation_id, turn) DO NOTHING`,
          [
            p.conversationId,
            pending.turn,
            outcome,
            chosen?.conversationId ?? null,
            outcome === "user_authored" ? userText : null,
            pending.candidates.map((c) => c.conversationId).filter((x) => x != null),
            JSON.stringify(Object.fromEntries(
              pending.candidates.map((c) => [c.slot, c.conversationId]),
            )),
            pending.stimulusEventId,
            reason ?? null,
          ],
        )
        .catch((err) => console.error("agent_selections insert failed:", err?.message));
    }

    // Only the selected (or operator-authored) response enters the
    // canonical transcript; unpicked candidates stay archived as rows.
    if (chosen) {
      await appendCanonical(deps, p, {
        role: "advisor",
        text: chosen.text,
        meta: { selection: outcome, harness: chosen.harness, candidate_id: chosen.conversationId },
      }, "assistant");
    } else if (outcome === "user_authored") {
      await appendCanonical(deps, p, {
        role: "advisor",
        text: userText!.trim(),
        meta: { selection: "user_authored" },
      }, "assistant");
    }

    // reveal identities only now that the selection is persisted
    p.lastSelection = {
      turn: pending.turn,
      outcome,
      revealed: pending.candidates.map((c) => ({
        slot: c.slot, harness: c.harness, model: c.model,
      })),
    };
    p.pending = null;
    return { ok: true, lastSelection: p.lastSelection };
  });

  startEventWatcher(deps);
}

// ---------------------------------------------------------------------------
// Event watcher: alerting defect_detection events auto-trigger a DATA turn
// + fan-out on the console panel (auto-created on first alert). Only the
// NEWEST alerting event is taken per poll — while a panel turn is busy or
// awaiting selection, newer alerts supersede older ones rather than queue.

function renderEventText(ev: {
  id: number; build_id: number | null; message: string | null;
  payload: Record<string, unknown>;
}): string {
  const p = ev.payload;
  const scores = Object.entries((p.scores as Record<string, number>) ?? {})
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(", ");
  return (
    `Defect model alert (event ${ev.id}) — build ${ev.build_id}, layer ${p.layer}, z2 ${p.z2}: ` +
    `alerts [${((p.alerts as string[]) ?? []).join(", ")}]; scores {${scores}}. ` +
    `The operator can confirm/ignore/reject the detection, add recoat passes, ` +
    `adjust temperatures, or exclude affected parts. What should they do?`
  );
}

function startEventWatcher(deps: PanelDeps): void {
  if (!deps.pool) return;
  let lastEventId: number | null = null;

  setInterval(() => {
    void (async () => {
      if (!deps.pool) return;
      try {
        if (lastEventId === null) {
          // start from "now" — never replay historical alerts on boot
          const { rows } = await deps.pool.query(`SELECT coalesce(max(id), 0) AS id FROM events`);
          lastEventId = Number(rows[0]?.id ?? 0);
          return;
        }
        const { rows } = await deps.pool.query(
          `SELECT id, build_id, message, payload FROM events
           WHERE kind = 'defect_detection' AND id > $1
             AND jsonb_array_length(payload->'alerts') > 0
           ORDER BY id`,
          [lastEventId],
        );
        // advance the cursor past everything seen this poll, alerting or not
        const { rows: maxRows } = await deps.pool.query(
          `SELECT coalesce(max(id), $1) AS id FROM events WHERE id > $1`, [lastEventId],
        );
        const maxSeen = Number(maxRows[0]?.id ?? lastEventId);
        if (rows.length === 0) { lastEventId = maxSeen; return; }
        lastEventId = maxSeen;

        let consolePanel = [...panels.values()].find((p) => p.console);
        if (!consolePanel) consolePanel = await createPanel(deps, { console: true });
        if (consolePanel.busy || consolePanel.pending) return; // superseded, not queued

        const ev = rows[rows.length - 1]; // newest alert wins
        void fanOut(
          deps,
          consolePanel,
          {
            role: "data",
            text: renderEventText(ev),
            meta: {
              event_id: Number(ev.id),
              build_id: ev.build_id != null ? Number(ev.build_id) : null,
              layer: ev.payload?.layer ?? null,
            },
          },
          Number(ev.id),
        );
      } catch (err) {
        console.error("panel event watcher:", (err as Error)?.message);
      }
    })();
  }, 5000);
}
