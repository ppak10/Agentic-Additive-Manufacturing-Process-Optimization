import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, ThumbsUp, ThumbsDown, Bell, BellOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Markdown } from "@/components/Markdown";
import { useSetArtifacts, type Artifact } from "@/panels/ArtifactPanel";
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

// One row of the agent-curated artifact panel (conversation_artifacts, via the
// artifact_* MCP tools). artifact_id is a job/profile UUID or a numeric build id.
interface ConvArtifact {
  artifact_type: "job" | "build" | "profile";
  artifact_id: string;
  provenance: "created" | "referenced";
  attached_by: "agent" | "operator";
  note: string | null;
  attached_at: string;
}

interface ConversationData {
  conversation: {
    id: number;
    created_at: string;
    harness: string;
    role: string;
    model: string | null;
    debug: boolean;
    alerts_muted: boolean;
  };
  messages: Msg[];
  builds: number[];
  artifacts: ConvArtifact[];
  feedback: FeedbackRow[];
}

// A build-scoped defect alert (build_alerts), delivered to every conversation
// that has the build attached. snapshot = the model's output: the input frame
// (served by the defect bridge, keyed by event_id) + the maps_png overlay.
interface BuildAlert {
  id: number;
  event_id: number;
  build_id: number;
  layer: number | null;
  alerts: string[];
  status: "new" | "addressed" | "dismissed";
  addressed_by_conversation_id: number | null;
  snapshot: { input_frame_event_id?: number; maps_png?: Record<string, string> | null } | null;
}

// Pointwise feedback (thumbs on a response now; action ratings later). For a
// response, target_id is the turn number as a string.
type Rating = "up" | "down";
interface FeedbackRow {
  target_kind: string;
  target_id: string;
  rating: string | null;
  correction: string | null;
  note: string | null;
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

// The right-hand artifact panel is the agent-curated set (conversation_artifacts,
// via the artifact_* MCP tools) — NOT a scrape of the transcript. This means a
// job the agent merely browsed (job_list / a comparison job_get) does NOT leak
// onto the panel; only artifacts it deliberately pinned (or created) appear.
function convArtifactToArtifact(a: ConvArtifact): Artifact {
  if (a.artifact_type === "build") return { kind: "build", buildId: a.artifact_id };
  if (a.artifact_type === "profile") return { kind: "profile", profileId: a.artifact_id };
  return { kind: "job", jobId: a.artifact_id };
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

// Per-turn thumbs on the model's response — the pointwise SFT signal. Clicking
// the active thumb again clears it. Rendered once at the end of each completed
// turn (never on the live, still-streaming turn).
function FeedbackBar({
  rating,
  onRate,
}: {
  rating: Rating | null;
  onRate: (r: Rating | null) => void;
}) {
  const btn = (r: Rating, label: string, Icon: typeof ThumbsUp) => (
    <button
      title={label}
      onClick={() => onRate(rating === r ? null : r)}
      className={cn(
        "rounded-base border-2 p-1 transition-colors",
        rating === r
          ? "bg-main border-border"
          : "border-transparent opacity-40 hover:opacity-100 hover:border-border/40",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
  return (
    <div className="flex items-center gap-1 pt-1 pl-1">
      {btn("up", "Good response", ThumbsUp)}
      {btn("down", "Bad response", ThumbsDown)}
    </div>
  );
}

// A defect-alert card — the model's output: its input chamber frame with the
// anomaly maps composited on top (maps span the full square input, so a simple
// stacked overlay registers pixel-for-pixel). "Address" marks the shared alert
// resolved for every conversation on this build.
function AlertCard({
  alert,
  onAddress,
}: {
  alert: BuildAlert;
  onAddress: () => void;
}) {
  const eventId = alert.snapshot?.input_frame_event_id ?? alert.event_id;
  const maps = alert.snapshot?.maps_png ?? {};
  const addressed = alert.status !== "new";
  return (
    <div className="border-2 border-red-500 rounded-base bg-red-50 dark:bg-red-950/40 shadow-shadow p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] font-mono uppercase tracking-wider opacity-60">
          defect alert · build {alert.build_id}
          {alert.layer != null ? ` · layer ${alert.layer}` : ""}
        </span>
        <div className="flex gap-1 flex-wrap">
          {alert.alerts.map((a) => (
            <span key={a} className="text-[10px] font-mono border border-red-500 rounded-base px-1 bg-red-100 dark:bg-red-900">
              {a}
            </span>
          ))}
        </div>
      </div>
      {/* input frame + overlay */}
      <div className="relative w-full max-w-xs border-2 border-border overflow-hidden">
        <img
          src={`/defect/frames/input/${eventId}`}
          alt="chamber input frame"
          className="block w-full"
          onError={(e) => ((e.currentTarget.style.display = "none"))}
        />
        {Object.entries(maps).map(([cls, b64]) => (
          <img
            key={cls}
            src={`data:image/png;base64,${b64}`}
            alt={`${cls} anomaly map`}
            className="pointer-events-none absolute inset-0 w-full h-full mix-blend-screen opacity-70"
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        {addressed ? (
          <span className="text-[10px] font-mono text-green-700 dark:text-green-400">
            addressed{alert.addressed_by_conversation_id ? ` in conv ${alert.addressed_by_conversation_id}` : ""}
          </span>
        ) : (
          <Button size="sm" variant="default" onClick={onAddress}>
            Mark addressed
          </Button>
        )}
      </div>
    </div>
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
  // The artifact tab the operator has focused (ArtifactSplit writes it here).
  // Sent with each message as `focus` so the agent's artifact_list sees what's
  // on screen; also pinned to the turn's user-message meta server-side.
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<ConversationData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Msg[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  // response ratings keyed by turn number; synced from the server, then
  // optimistically updated on click
  const [ratings, setRatings] = useState<Record<number, Rating | null>>({});
  // build-scoped defect alerts for this conversation's attached build(s)
  const [alerts, setAlerts] = useState<BuildAlert[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // aborts the in-flight SSE fetch so Stop unsticks the client even if the
  // stream is half-open (e.g. the broker restarted mid-turn)
  const abortRef = useRef<AbortController | null>(null);
  // seconds elapsed in the current turn, for the live activity indicator
  const [elapsed, setElapsed] = useState(0);

  // keep the composer height in sync with its content (also resets it after a
  // send clears `input`)
  useEffect(() => {
    autosize(taRef.current);
  }, [input]);

  // ── right-hand artifact panel ──
  // The conversation's artifacts: the agent-curated pinned set (jobs, builds,
  // profiles). The live Mission Control feed is added globally in the app shell
  // while a print runs (not here), so it shows on every page's panel.
  // ArtifactSplit owns ordering / auto-switch / open-close / resize and the
  // URL-backed active tab; here we only produce the list.
  const artifacts = useMemo<Artifact[]>(
    () => (data?.artifacts ?? []).map(convArtifactToArtifact),
    [data?.artifacts],
  );
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

  // hydrate response ratings from the loaded conversation
  useEffect(() => {
    const map: Record<number, Rating | null> = {};
    for (const f of data?.feedback ?? []) {
      if (f.target_kind === "response" && (f.rating === "up" || f.rating === "down")) {
        map[Number(f.target_id)] = f.rating;
      }
    }
    setRatings(map);
  }, [data?.feedback]);

  // tick an elapsed-seconds counter while a turn runs (reset when it ends)
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // What the model is doing right now, inferred from the last streamed event —
  // so the indicator reads "calling profile_get" / "writing" instead of a
  // static "thinking". Tool names may be namespaced (mcp__srv__tool); show the
  // bare tool.
  const liveActivity = useMemo(() => {
    const last = live && live.length > 0 ? live[live.length - 1] : null;
    if (!last) return "thinking";
    if (last.kind === "tool_call") {
      const n = last.tool_name ?? "tool";
      const bare = n.includes("__") ? n.slice(n.lastIndexOf("__") + 2) : n;
      return `calling ${bare}`;
    }
    if (last.kind === "tool_result") return "reading result";
    if (last.kind === "assistant") return "writing";
    return "thinking";
  }, [live]);

  // thumbs on a model response (per turn) — optimistic; clicking the active
  // thumb passes null, which clears the row server-side
  const rate = async (turn: number, r: Rating | null) => {
    setRatings((prev) => ({ ...prev, [turn]: r }));
    try {
      await fetch(`/agent/conversations/${id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_kind: "response", target_id: turn, rating: r }),
      });
    } catch {
      /* next load re-syncs true state */
    }
  };

  // Poll build-scoped defect alerts for this conversation's attached build(s).
  // The bell/silence toggle (below) controls whether they SURFACE, not whether
  // we fetch — status is shared, so we keep it current either way.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/agent/conversations/${id}/alerts`);
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as { alerts?: BuildAlert[] };
        if (!cancelled) setAlerts(d.alerts ?? []);
      } catch { /* broker unreachable — next tick retries */ }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  // Mark a shared alert addressed — reflects in every conversation on the build.
  const addressAlert = async (alertId: number) => {
    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alertId
          ? { ...a, status: "addressed", addressed_by_conversation_id: Number(id) }
          : a,
      ),
    );
    try {
      await fetch(`/agent/alerts/${alertId}/address`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "addressed", conversation_id: Number(id) }),
      });
    } catch { /* next poll re-syncs */ }
  };

  // Bell / silence — per-conversation mute for defect notifications. Optimistic;
  // PATCH persists it (the poll/load re-syncs on failure).
  const toggleMute = async () => {
    if (!data) return;
    const next = !data.conversation.alerts_muted;
    setData({ ...data, conversation: { ...data.conversation, alerts_muted: next } });
    try {
      const r = await fetch(`/agent/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alerts_muted: next }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      setData((d) =>
        d ? { ...d, conversation: { ...d.conversation, alerts_muted: !next } } : d,
      );
    }
  };

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
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const focus = searchParams.get("artifact") ?? undefined;
      const r = await fetch(`/agent/conversations/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, focus }),
        signal: ac.signal,
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
      // an aborted fetch is a deliberate Stop, not an error
      if ((e as Error)?.name !== "AbortError") setErr(String((e as Error).message ?? e));
      await load().catch(() => {}); // pull whatever partial turn was recorded
    } finally {
      abortRef.current = null;
      setLive(null);
      setBusy(false);
    }
  };

  // stop the in-flight turn — kill the broker's CLI process AND abort the local
  // SSE fetch, so the client unsticks immediately even if the stream is
  // half-open (e.g. the broker was restarted mid-turn). send()'s finally clears
  // busy and pulls the partial turn.
  const stop = async () => {
    abortRef.current?.abort();
    try {
      await fetch(`/agent/conversations/${id}/stop`, { method: "POST" });
    } catch {
      /* server may already be gone; the local abort already freed the UI */
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
  // only persisted turns get a thumbs bar — never the live, still-streaming one
  const persistedMaxTurn = messages.at(-1)?.turn ?? 0;
  let prevTurn = 0;

  const muted = c.alerts_muted;
  const activeAlerts = alerts.filter((a) => a.status === "new");
  // the bell rides in the breadcrumb row (rendered by the app shell)
  const breadcrumbSlot =
    typeof document !== "undefined" ? document.getElementById("breadcrumb-actions") : null;

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* bell / silence — per-conversation defect-alert mute, in the breadcrumb row */}
      {breadcrumbSlot &&
        createPortal(
          <button
            onClick={() => void toggleMute()}
            title={
              muted
                ? "Defect alerts silenced for this conversation — click to enable"
                : "Defect alerts on — click to silence"
            }
            className={cn(
              "flex items-center gap-1 rounded-base border-2 px-2 py-1 text-[10px] font-mono uppercase",
              muted
                ? "border-border/40 opacity-50 hover:opacity-100"
                : "bg-main border-border",
            )}
          >
            {muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
            {activeAlerts.length > 0 && !muted ? activeAlerts.length : null}
          </button>,
          breadcrumbSlot,
        )}
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
              // last row of a completed turn gets the response thumbs
              const lastOfTurn = i === items.length - 1 || itemTurn(items[i + 1]) !== turn;
              const showFeedback = lastOfTurn && turn > 0 && turn <= persistedMaxTurn;
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
                  {showFeedback && (
                    <FeedbackBar rating={ratings[turn] ?? null} onRate={(r) => void rate(turn, r)} />
                  )}
                </div>
              );
            })}
            {busy && (
              <div className="border-2 border-dashed border-border rounded-base px-3 py-2 flex items-center gap-2 font-mono text-xs">
                <span className="inline-flex gap-0.5" aria-hidden>
                  <span className="size-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
                  <span className="size-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
                  <span className="size-1.5 rounded-full bg-current animate-bounce" />
                </span>
                <span className="font-heading">{c.harness}</span>
                <span className="opacity-80">{liveActivity}…</span>
                <span className="ml-auto tabular-nums opacity-50">
                  {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}
                  {elapsed >= 45 && (
                    <span className="ml-1 opacity-70">· taking a while, you can Stop</span>
                  )}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {!muted && activeAlerts.length > 0 && (
        <div className="border-t-2 border-red-500 shrink-0">
          <div className="max-w-3xl mx-auto p-2 flex flex-col gap-2">
            {activeAlerts.map((a) => (
              <AlertCard key={a.id} alert={a} onAddress={() => void addressAlert(a.id)} />
            ))}
          </div>
        </div>
      )}

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
            {busy ? (
              <Button onClick={() => void stop()} variant="neutral" size="sm" title="Stop this turn">
                Stop
              </Button>
            ) : (
              <Button onClick={() => void send()} disabled={!input.trim()} variant="default" size="sm">
                Send
              </Button>
            )}
          </div>
          {err && <div className="max-w-3xl mx-auto px-2 pb-1 text-red-600 text-[10px]">{err}</div>}
        </div>
      )}
    </div>
  );
}
