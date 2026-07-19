import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Markdown } from "@/components/Markdown";
import { useSetArtifacts, type Artifact } from "@/panels/ArtifactPanel";
import { useIsPrinting } from "@/hooks/useIsPrinting";
import { refreshConversations } from "@/hooks/useConversations";
import { cn } from "@/lib/utils";

// Conversation page — the sidebar's Conversations list links here.
// Chat-style layout (2026-07-18): user turns as right-aligned bubbles,
// assistant markdown flowing unboxed, tool_call+tool_result paired into
// collapsed rows, printer events as amber alerts, meta rows as centered
// dividers. Prose is sans; tool/code surfaces stay mono.
//
// role='chat' conversations are INTERACTIVE: a composer posts to
// /agent/conversations/:id/messages and streams the turn's events over
// SSE (the broker rehydrates the CLI session after restarts). All other
// roles (panel, adhoc, smoke, panel:candidate) stay read-only.
//
// /conversations/new renders a DRAFT: centered picker + composer, no
// broker call until the first send — which creates the chat and hands the
// message to the real page via navigation state (autoSend).

interface Msg {
  turn: number;
  seq: number;
  ts: string;
  kind: string;
  content: string | null;
  tool_name: string | null;
  tool_input: unknown;
  is_error: boolean | null;
}

interface ConversationData {
  conversation: {
    id: number;
    created_at: string;
    harness: string;
    role: string;
    model: string | null;
    debug: boolean;
  };
  messages: Msg[];
  builds: number[];
}

type ApprovalMode = "ask" | "auto" | "plan";
interface PendingApproval {
  id: number;
  tool: string;
  arguments: unknown;
  created_at: string;
}

// A tool_result directly after its tool_call collapses into one row.
type Item =
  | { type: "msg"; msg: Msg }
  | { type: "tool"; call: Msg | null; result: Msg | null };

function groupMessages(messages: Msg[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.kind === "tool_call") {
      items.push({ type: "tool", call: m, result: null });
    } else if (m.kind === "tool_result") {
      const last = items[items.length - 1];
      if (last?.type === "tool" && last.result === null && last.call?.turn === m.turn) {
        last.result = m;
      } else {
        items.push({ type: "tool", call: null, result: m });
      }
    } else {
      items.push({ type: "msg", msg: m });
    }
  }
  return items;
}

function itemTurn(it: Item): number {
  return it.type === "msg" ? it.msg.turn : (it.call ?? it.result)!.turn;
}

// ── artifact derivation ─────────────────────────────────────────────────────
// The right-hand artifact panel is a pure projection of the transcript. MVP:
// jobs only. Harnesses may namespace MCP tools (Claude → mcp__<srv>__job_get),
// so compare on the segment after the last "__".
function bareToolName(name: string | null): string {
  if (!name) return "";
  const i = name.lastIndexOf("__");
  return i >= 0 ? name.slice(i + 2) : name;
}

// Every job the agent referenced, in first-appearance order (deduped):
// job_get/job_set carry the id in tool_input.job_id; job_create_from_template
// returns the NEW job id in its result JSON. Each becomes an artifact tab.
function deriveJobIds(messages: Msg[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  let lastCall: string | null = null;
  for (const m of messages) {
    if (m.kind === "tool_call") {
      lastCall = bareToolName(m.tool_name);
      const input = m.tool_input as Record<string, unknown> | null;
      if ((lastCall === "job_get" || lastCall === "job_set") && typeof input?.job_id === "string") {
        add(input.job_id);
      }
    } else if (m.kind === "tool_result") {
      if (lastCall === "job_create_from_template" && m.content) {
        try {
          const j = JSON.parse(m.content) as { id?: unknown };
          if (typeof j.id === "string") add(j.id);
        } catch { /* result wasn't JSON */ }
      }
      lastCall = null;
    }
  }
  return ids;
}

function inputPreview(input: unknown): string {
  if (input == null) return "";
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return "";
  }
}

function ToolRow({ call, result }: { call: Msg | null; result: Msg | null }) {
  const isError = call?.is_error || result?.is_error;
  return (
    <details
      className={cn(
        "group border rounded-base font-mono text-[11px] bg-secondary-background/40",
        isError ? "border-red-500" : "border-border/50",
      )}
    >
      <summary className="cursor-pointer select-none px-2 py-1 flex items-center gap-1.5 opacity-70 hover:opacity-100 list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <span className="font-heading shrink-0">{call?.tool_name ?? "tool result"}</span>
        <span className="truncate opacity-60">{call ? inputPreview(call.tool_input) : ""}</span>
        {isError && <span className="ml-auto shrink-0 text-red-600">error</span>}
      </summary>
      <div className="border-t border-border/50 px-2 py-1.5 grid gap-1.5">
        {call?.tool_input != null && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] opacity-80">
            {typeof call.tool_input === "string"
              ? call.tool_input
              : JSON.stringify(call.tool_input, null, 2)}
          </pre>
        )}
        {call?.content && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] opacity-80">{call.content}</pre>
        )}
        {result ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] border-t border-border/30 pt-1.5">
            {result.content ?? "(empty result)"}
          </pre>
        ) : (
          <div className="text-[10px] opacity-50">(no result recorded)</div>
        )}
      </div>
    </details>
  );
}

function MessageItem({ m }: { m: Msg }) {
  if (m.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] border-2 border-border rounded-base shadow-shadow bg-secondary-background px-3 py-2 whitespace-pre-wrap break-words">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.kind === "assistant") {
    return (
      <div className={cn("py-1", m.is_error && "border-l-4 border-red-500 pl-2")}>
        {m.content ? <Markdown text={m.content} /> : null}
      </div>
    );
  }
  if (m.kind === "event") {
    return (
      <Alert className="bg-amber-300 text-black py-2 px-3">
        <AlertTitle className="text-[9px] font-mono uppercase tracking-wider opacity-60">
          printer data
        </AlertTitle>
        <AlertDescription className="whitespace-pre-wrap text-xs font-mono text-black">
          {m.content}
        </AlertDescription>
      </Alert>
    );
  }
  if (m.kind === "context") {
    return (
      <details className="group border border-border/50 rounded-base font-mono text-[11px] bg-secondary-background/40 opacity-70">
        <summary className="cursor-pointer select-none px-2 py-1 flex items-center gap-1.5 list-none [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
          <span className="font-heading">attached context</span>
        </summary>
        <pre className="border-t border-border/50 px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all text-[10px]">
          {m.content}
        </pre>
      </details>
    );
  }
  // meta + anything unrecognized: faint centered divider text
  return (
    <div
      className={cn(
        "text-center text-[10px] font-mono opacity-50 py-0.5",
        m.is_error && "text-red-600 opacity-100",
      )}
    >
      {m.content ?? m.kind}
    </div>
  );
}

// Normalized SSE event from the broker (same shape the store persists).
interface StreamEv {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  message?: string;
}

function evToMsg(ev: StreamEv, turn: number, seq: number): Msg | null {
  const base = { turn, seq, ts: "", tool_name: null, tool_input: null, is_error: null };
  if (ev.type === "text") return { ...base, kind: "assistant", content: ev.text ?? "" };
  if (ev.type === "tool") {
    return { ...base, kind: "tool_call", content: null, tool_name: ev.name ?? "tool", tool_input: ev.input };
  }
  if (ev.type === "tool_result") return { ...base, kind: "tool_result", content: ev.text ?? "" };
  if (ev.type === "error") {
    return { ...base, kind: "meta", content: ev.message ?? "error", is_error: true };
  }
  return null; // done
}

const CHAT_HARNESSES = ["claude", "opencode", "codex", "agy"] as const;

// Composer auto-grow: the textarea starts one line tall (≈ the Send button)
// and grows to fit its content, capped at MAX_COMPOSER_HEIGHT px before it
// scrolls internally. Reset to "auto" first so it can also shrink.
const MAX_COMPOSER_HEIGHT = 160; // px — matches the max-h-40 class below
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  const border = el.offsetHeight - el.clientHeight; // border-box: add borders back
  const next = Math.min(el.scrollHeight + border, MAX_COMPOSER_HEIGHT);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight + border > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
}

function NewChatDraft() {
  const navigate = useNavigate();
  const [harness, setHarness] = useState<(typeof CHAT_HARNESSES)[number]>("claude");
  const [debug, setDebug] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/agent/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harness, debug }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
      const d = (await r.json()) as { conversationId: number | string | null };
      if (d.conversationId == null) {
        throw new Error("broker has no database — chat would not be recorded");
      }
      refreshConversations();
      navigate(`/conversations/${d.conversationId}`, {
        replace: true,
        state: { autoSend: message },
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setBusy(false);
    }
  };

  const pick = (
    label: string,
    values: readonly string[],
    current: string,
    set: (v: string) => void,
  ) => (
    <div className="flex items-center gap-1 font-mono text-xs">
      <span className="opacity-50 w-16 text-right mr-1">{label}</span>
      {values.map((v) => (
        <button
          key={v}
          onClick={() => set(v)}
          className={cn(
            "px-2 py-1 rounded border border-border",
            current === v ? "bg-accent" : "opacity-60 hover:opacity-100",
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col items-center justify-center gap-4 p-4">
      <div className="font-heading text-lg">New conversation</div>
      {pick("harness", CHAT_HARNESSES, harness, (v) => setHarness(v as typeof harness))}
      <label className="flex items-center gap-2 font-mono text-xs cursor-pointer select-none">
        <input
          type="checkbox"
          checked={debug}
          onChange={(e) => setDebug(e.target.checked)}
          className="accent-main size-3.5"
        />
        <span className={debug ? "" : "opacity-60"}>
          debug — dev/test conversation, excluded from the dataset export
        </span>
      </label>
      <div className="w-full max-w-xl flex gap-2 items-end">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          rows={3}
          autoFocus
          placeholder={`Message ${harness}…`}
          className="flex-1 resize-none min-h-0 text-xs font-mono"
        />
        <Button onClick={() => void start()} disabled={!input.trim() || busy} variant="default" size="sm">
          {busy ? "…" : "Send"}
        </Button>
      </div>
      <div className="text-[10px] font-mono opacity-50 max-w-xl text-center">
        Nothing is recorded until you send — the chat and its conversation
        record are created with the first message.
      </div>
      {err && <div className="text-red-600 text-[10px] font-mono">{err}</div>}
    </div>
  );
}

export function ConversationPage() {
  const { id } = useParams();
  if (id === "new") return <NewChatDraft />;
  return <ExistingConversation id={id!} />;
}

function ExistingConversation({ id }: { id: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState<ConversationData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Msg[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // keep the composer height in sync with its content (also resets it after a
  // send clears `input`)
  useEffect(() => {
    autosize(taRef.current);
  }, [input]);

  // ── right-hand artifact panel ──
  // The conversation's artifacts: every job the transcript referenced (as tabs)
  // plus the live Mission Control feed while a print runs. ArtifactSplit owns
  // ordering / auto-switch / open-close / resize; here we only produce the list.
  const printing = useIsPrinting();
  const jobIds = useMemo(
    () => deriveJobIds([...(data?.messages ?? []), ...(live ?? [])]),
    [data?.messages, live],
  );
  const artifacts = useMemo<Artifact[]>(() => {
    const list: Artifact[] = jobIds.map((jobId) => ({ kind: "job", jobId }));
    if (printing) list.push({ kind: "chamber" });
    return list;
  }, [jobIds, printing]);
  useSetArtifacts(artifacts);

  const load = useCallback(async () => {
    const r = await fetch(`/agent/conversations/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setData(await r.json());
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLive(null);
    setErr(null);
    load().catch((e) => !cancelled && setErr(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const interactive = data?.conversation.role === "chat";

  // ── approval gate (human-in-the-loop for mutating MCP tools) ──
  // The MCP server blocks a mutating tool and files a pending row; we poll for
  // it and for the current mode, surface an inline Approve/Decline card, and
  // let the operator switch modes (ask/auto/plan) — the harness analogue of
  // Claude Code's permission prompt.
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/agent/conversations/${id}/approvals`);
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as { mode?: ApprovalMode; pending?: PendingApproval[] };
        if (cancelled) return;
        setApprovalMode(d.mode ?? "ask");
        setPendingApprovals(d.pending ?? []);
      } catch { /* broker unreachable — next tick retries */ }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, interactive]);

  const setMode = async (mode: ApprovalMode) => {
    setApprovalMode(mode); // optimistic; the poll re-syncs
    try {
      await fetch(`/agent/conversations/${id}/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    } catch { /* next poll restores true state */ }
  };
  const decideApproval = async (approvalId: number, decision: "approved" | "declined") => {
    setPendingApprovals((p) => p.filter((a) => a.id !== approvalId)); // optimistic
    try {
      await fetch(`/agent/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    } catch { /* next poll restores it if the write failed */ }
  };

  // keep the newest turn in view while chatting/streaming
  useEffect(() => {
    if (interactive) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [interactive, data?.messages.length, live?.length]);

  // The draft page hands off the first message via navigation state —
  // consume it exactly once (replace the history entry so a refresh
  // doesn't resend), then fire the turn.
  const autoSent = useRef(false);
  useEffect(() => {
    const pending = (location.state as { autoSend?: string } | null)?.autoSend;
    if (pending && data?.conversation.role === "chat" && !autoSent.current) {
      autoSent.current = true;
      navigate(location.pathname, { replace: true });
      void send(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send changes every render; autoSent guards
  }, [data, location.state]);

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy || !data) return;
    setBusy(true);
    setErr(null);
    if (text === undefined) setInput("");
    const turn = (data.messages.at(-1)?.turn ?? 0) + 1;
    const acc: Msg[] = [
      { turn, seq: 0, ts: "", kind: "user", content: message, tool_name: null, tool_input: null, is_error: null },
    ];
    setLive([...acc]);
    try {
      const r = await fetch(`/agent/conversations/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!r.ok || !r.body) {
        throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const m = evToMsg(JSON.parse(line.slice(6)) as StreamEv, turn, acc.length);
            if (m) {
              acc.push(m);
              setLive([...acc]);
            }
          } catch { /* partial/garbled line */ }
        }
      }
      await load();
      refreshConversations(); // first turn gives the sidebar its title
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLive(null);
      setBusy(false);
    }
  };

  // debug flag toggle — optimistic; PATCH also covers panel candidates
  const toggleDebug = async () => {
    if (!data) return;
    const next = !data.conversation.debug;
    setData({ ...data, conversation: { ...data.conversation, debug: next } });
    try {
      const r = await fetch(`/agent/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ debug: next }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      refreshConversations();
    } catch (e) {
      setData((d) => (d ? { ...d, conversation: { ...d.conversation, debug: !next } } : d));
      setErr(String((e as Error).message ?? e));
    }
  };

  if (err && !data) {
    return <div className="p-4 text-xs text-red-600">Failed to load conversation {id}: {err}</div>;
  }
  if (!data) return <div className="p-4 text-xs opacity-60">Loading conversation…</div>;

  const { conversation: c, messages, builds } = data;
  const items = groupMessages(live ? [...messages, ...live] : messages);
  let prevTurn = 0;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 max-w-3xl mx-auto">
          {/* slim header — metadata only, transcript flows unboxed below */}
          <div className="flex items-center gap-2 flex-wrap border-b-2 border-border pb-2 mb-4 text-sm">
            <span className="font-heading">Conversation {c.id}</span>
            <Badge variant="neutral">{c.role}</Badge>
            <Badge variant="neutral">{c.harness}</Badge>
            <button
              onClick={() => void toggleDebug()}
              title="Debug conversations are excluded from the dataset export"
              className={cn(
                "border-2 rounded-base px-1.5 py-0.5 text-[10px] font-mono uppercase",
                c.debug
                  ? "bg-main border-border"
                  : "border-border/40 opacity-40 hover:opacity-100",
              )}
            >
              debug
            </button>
            {interactive && (
              <span className="flex items-center gap-1 text-[10px] font-mono">
                <span className="opacity-50">mode</span>
                {(["ask", "auto", "plan"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => void setMode(m)}
                    title={
                      m === "ask"
                        ? "Ask — mutating tools need your approval"
                        : m === "auto"
                          ? "Auto — run mutating tools without asking"
                          : "Plan — refuse mutating tools (read-only)"
                    }
                    className={cn(
                      "px-1.5 py-0.5 rounded-base border-2 uppercase",
                      approvalMode === m
                        ? "bg-main border-border"
                        : "border-border/40 opacity-50 hover:opacity-100",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </span>
            )}
            {c.model && <span className="text-[10px] font-mono opacity-60">{c.model}</span>}
            {builds.length > 0 && (
              <span className="text-[10px] font-mono opacity-60">
                builds: {builds.map((b, i) => (
                  <Link key={b} to={`/builds/${b}`} className="underline">
                    {i > 0 ? ", " : ""}{b}
                  </Link>
                ))}
              </span>
            )}
            <span className="ml-auto text-[10px] font-mono opacity-50">
              {new Date(c.created_at).toLocaleString()}
            </span>
          </div>

          {items.length === 0 && (
            <div className="text-xs opacity-50">
              {interactive ? "No messages yet — say hello below." : "No messages recorded."}
            </div>
          )}

          {/* font-sans: chat prose reads as a document; the app's mono base
              stays on tool rows/events, which set font-mono themselves */}
          <div className="flex flex-col gap-2 text-sm font-sans">
            {items.map((it, i) => {
              const turn = itemTurn(it);
              const newTurn = turn !== prevTurn && prevTurn !== 0;
              prevTurn = turn;
              return (
                <div key={i}>
                  {newTurn && (
                    <div className="flex items-center gap-2 my-3 opacity-40">
                      <div className="flex-1 border-t border-border" />
                      <span className="text-[9px] font-mono uppercase tracking-wider">turn {turn}</span>
                      <div className="flex-1 border-t border-border" />
                    </div>
                  )}
                  {it.type === "tool" ? <ToolRow call={it.call} result={it.result} /> : <MessageItem m={it.msg} />}
                </div>
              );
            })}
            {busy && (
              <div className="border-2 border-dashed border-border rounded-base px-2 py-3 text-center font-mono text-xs animate-pulse">
                {c.harness} thinking…
              </div>
            )}
          </div>
        </div>
      </div>

      {interactive && pendingApprovals.length > 0 && (
        <div className="border-t-2 border-amber-500 shrink-0">
          <div className="max-w-3xl mx-auto p-2 flex flex-col gap-2">
            {pendingApprovals.map((a) => (
              <div
                key={a.id}
                className="border-2 border-amber-500 rounded-base bg-amber-100 dark:bg-amber-950 shadow-shadow p-2 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono uppercase tracking-wider opacity-60">
                    approval required
                  </span>
                  <span className="font-heading text-sm">{a.tool}</span>
                </div>
                <pre className="text-[10px] font-mono overflow-x-auto whitespace-pre-wrap break-all opacity-80">
                  {JSON.stringify(a.arguments, null, 2)}
                </pre>
                <div className="flex gap-2">
                  <Button size="sm" variant="default" onClick={() => void decideApproval(a.id, "approved")}>
                    Approve
                  </Button>
                  <Button size="sm" variant="neutral" onClick={() => void decideApproval(a.id, "declined")}>
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {interactive && (
        <div className="shrink-0">
          <div className="max-w-3xl mx-auto p-2 flex gap-2 items-end">
            <Textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={`Message ${c.harness}…`}
              className="flex-1 resize-none min-h-0 max-h-40 text-xs font-mono"
            />
            <Button onClick={() => void send()} disabled={!input.trim() || busy} variant="default" size="sm">
              Send
            </Button>
          </div>
          {err && <div className="max-w-3xl mx-auto px-2 pb-1 text-red-600 text-[10px]">{err}</div>}
        </div>
      )}
    </div>
  );
}
