import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, ChevronRight, Copy, Settings as SettingsIcon, ThumbsUp, ThumbsDown, Bell, BellOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { HarnessIcon, HARNESS_LABELS, HARNESS_MODELS, modelLabel } from "@/components/HarnessIcon";
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
// artifact_* MCP tools). artifact_id is a job/profile UUID or a numeric build
// id; powder_tuning is a singleton (id 'session') for the live tuning view.
interface ConvArtifact {
  artifact_type: "job" | "build" | "profile" | "powder_tuning";
  artifact_id: string;
  provenance: "created" | "referenced";
  attached_by: "agent" | "operator" | "system";
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

// Approval-mode tabs, labeled with the backend values themselves
// (agent_conversation_settings.approval_mode). Ordered strictest → loosest.
const APPROVAL_TABS: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: "plan", label: "Plan", hint: "write actions are refused — the agent reads, you act" },
  { value: "ask", label: "Ask", hint: "write actions need your approval" },
  { value: "auto", label: "Auto", hint: "every tool action runs without asking" },
];

// The segmented approval-mode control — shared by the conversation composer
// and the new-conversation draft so the two read identically.
function ModeTabs({
  value,
  onChange,
}: {
  value: ApprovalMode;
  onChange: (m: ApprovalMode) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono">
      <div className="flex rounded-base border-2 border-border overflow-hidden">
        {APPROVAL_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            title={t.hint}
            className={cn(
              "px-2 py-0.5 font-heading transition-colors",
              value === t.value
                ? "bg-main text-main-foreground"
                : "bg-background opacity-50 hover:opacity-100 hover:bg-secondary-background",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <span className="opacity-50">
        {APPROVAL_TABS.find((t) => t.value === value)?.hint}
      </span>
    </div>
  );
}
interface PendingApproval {
  id: number;
  tool: string;
  arguments: unknown;
  created_at: string;
}

// Model picker — bottom-right of the composer, Claude-Desktop style. `value`
// is the conversation's model OVERRIDE (null = harness default); `observed`
// is what the CLI stream actually reported, shown when no override is set so
// the operator always knows the model in use. Selecting "Default" clears the
// override. Menu opens upward (the composer sits at the window bottom).
function ModelPicker({
  harness,
  value,
  observed,
  onChange,
  disabled,
}: {
  harness: string;
  value: string | null;
  observed?: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const models = HARNESS_MODELS[harness] ?? [];
  const current = value ?? observed ?? null;
  // an override / observed id outside the catalog still needs a menu entry
  const extra =
    current && !models.some((m) => m.id === current)
      ? [{ id: current, label: modelLabel(harness, current) }]
      : [];
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={current ?? "harness default model"}
        className={cn(
          "flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-base",
          "opacity-60 hover:opacity-100 hover:bg-secondary-background disabled:opacity-30",
        )}
      >
        {modelLabel(harness, current)}
        <ChevronRight className={cn("size-3 transition-transform", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 z-20 min-w-44 border-2 border-border rounded-base bg-background shadow-shadow overflow-hidden flex flex-col">
          {[...models, ...extra].map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              className={cn(
                "px-3 py-1.5 text-left font-mono text-xs flex items-center justify-between gap-3",
                value === m.id
                  ? "bg-main text-main-foreground"
                  : "bg-background hover:bg-secondary-background",
              )}
            >
              <span>{m.label}</span>
              <span className="text-[9px] opacity-50">{m.id}</span>
            </button>
          ))}
          <button
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(
              "px-3 py-1.5 text-left font-mono text-xs border-t-2 border-border",
              value == null
                ? "bg-main text-main-foreground"
                : "bg-background hover:bg-secondary-background",
            )}
          >
            Default ({HARNESS_LABELS[harness] ?? harness})
          </button>
        </div>
      )}
    </div>
  );
}

// A tool_result pairs with its tool_call, and an unbroken run of tool
// activity within a turn condenses into ONE group item — rendered as a
// single dynamic row while streaming, a "N tool calls" dropdown once done.
type ToolPair = { call: Msg | null; result: Msg | null };
type Item =
  | { type: "msg"; msg: Msg }
  | { type: "tools"; turn: number; tools: ToolPair[] };

function groupMessages(messages: Msg[]): Item[] {
  const items: Item[] = [];
  const tailGroup = (turn: number) => {
    const last = items[items.length - 1];
    return last?.type === "tools" && last.turn === turn ? last : null;
  };
  for (const m of messages) {
    if (m.kind === "tool_call") {
      const g = tailGroup(m.turn);
      if (g) g.tools.push({ call: m, result: null });
      else items.push({ type: "tools", turn: m.turn, tools: [{ call: m, result: null }] });
    } else if (m.kind === "tool_result") {
      const g = tailGroup(m.turn);
      // pair with the earliest unresolved call (parallel batches emit all
      // calls, then all results — FIFO is the stream order)
      const open = g?.tools.find((t) => t.call !== null && t.result === null);
      if (open) open.result = m;
      else if (g) g.tools.push({ call: null, result: m });
      else items.push({ type: "tools", turn: m.turn, tools: [{ call: null, result: m }] });
    } else {
      items.push({ type: "msg", msg: m });
    }
  }
  return items;
}

function itemTurn(it: Item): number {
  return it.type === "msg" ? it.msg.turn : it.turn;
}

// "mcp__agentic-sls__printer_status" → "printer_status"
function bareToolName(n: string | null | undefined): string {
  if (!n) return "tool";
  return n.includes("__") ? n.slice(n.lastIndexOf("__") + 2) : n;
}

// The right-hand artifact panel is the agent-curated set (conversation_artifacts,
// via the artifact_* MCP tools) — NOT a scrape of the transcript. This means a
// job the agent merely browsed (job_list / a comparison job_get) does NOT leak
// onto the panel; only artifacts it deliberately pinned (or created) appear.
function convArtifactToArtifact(a: ConvArtifact): Artifact {
  if (a.artifact_type === "build") return { kind: "build", buildId: a.artifact_id };
  if (a.artifact_type === "profile") return { kind: "profile", profileId: a.artifact_id };
  if (a.artifact_type === "powder_tuning") return { kind: "powder_tuning" };
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

// A condensed run of tool calls. Three shapes:
//  - streaming: ONE row that dynamically shows the tool currently running
//    (count ticks up as calls land) — no expansion while in flight;
//  - done, single call: the plain ToolRow, no extra chrome;
//  - done, several calls: one "N tool calls" dropdown row; open it to
//    navigate the individual (expandable) tool rows.
function ToolGroupRow({ tools, streaming }: { tools: ToolPair[]; streaming: boolean }) {
  const errors = tools.filter((t) => t.call?.is_error || t.result?.is_error).length;

  if (streaming) {
    const current = tools[tools.length - 1]!;
    const running = current.result === null && current.call !== null;
    return (
      <div className="border border-border/50 rounded-base font-mono text-[11px] bg-secondary-background/40 px-2 py-1 flex items-center gap-1.5 opacity-80">
        <span className="relative flex size-2 shrink-0" aria-hidden>
          <span className={cn("absolute inline-flex h-full w-full rounded-full bg-main", running && "animate-ping opacity-75")} />
          <span className="relative inline-flex size-2 rounded-full bg-main" />
        </span>
        <span className="font-heading shrink-0">{bareToolName(current.call?.tool_name)}</span>
        <span className="truncate opacity-60">{current.call ? inputPreview(current.call.tool_input) : ""}</span>
        <span className="ml-auto shrink-0 opacity-50">
          {tools.length > 1 ? `${tools.length} calls` : running ? "running" : "done"}
        </span>
      </div>
    );
  }

  if (tools.length === 1) return <ToolRow call={tools[0]!.call} result={tools[0]!.result} />;

  // unique bare names, in first-use order, for the summary line
  const names: string[] = [];
  for (const t of tools) {
    const n = bareToolName(t.call?.tool_name);
    if (!names.includes(n)) names.push(n);
  }
  const namesPreview = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");

  return (
    <details
      className={cn(
        "group border rounded-base font-mono text-[11px] bg-secondary-background/40",
        errors > 0 ? "border-red-500" : "border-border/50",
      )}
    >
      <summary className="cursor-pointer select-none px-2 py-1 flex items-center gap-1.5 opacity-70 hover:opacity-100 list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <span className="font-heading shrink-0">{tools.length} tool calls</span>
        <span className="truncate opacity-60">{namesPreview}</span>
        {errors > 0 && (
          <span className="ml-auto shrink-0 text-red-600">
            {errors} error{errors > 1 ? "s" : ""}
          </span>
        )}
      </summary>
      <div className="border-t border-border/50 px-1.5 py-1.5 grid gap-1">
        {tools.map((t, i) => (
          <ToolRow key={i} call={t.call} result={t.result} />
        ))}
      </div>
    </details>
  );
}

// Copy with a legacy fallback: navigator.clipboard needs a secure context,
// and the dashboard is also reached over plain http from other machines on
// the LAN — execCommand still works there.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// Per-turn thumbs on the model's response — the pointwise SFT signal. Clicking
// the active thumb again clears it. Rendered once at the end of each completed
// turn (never on the live, still-streaming turn). copyText is the turn's
// assistant prose (tool rows excluded); no prose → no copy button.
function FeedbackBar({
  rating,
  onRate,
  copyText,
}: {
  rating: Rating | null;
  onRate: (r: Rating | null) => void;
  copyText: string | null;
}) {
  const [copied, setCopied] = useState(false);
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
  const copy = async () => {
    if (!copyText || copied) return;
    if (await copyToClipboard(copyText)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="flex items-center gap-1 pt-1 pl-1">
      {btn("up", "Good response", ThumbsUp)}
      {btn("down", "Bad response", ThumbsDown)}
      {copyText && (
        <button
          title={copied ? "Copied" : "Copy response"}
          onClick={() => void copy()}
          className={cn(
            "rounded-base border-2 p-1 transition-colors",
            copied
              ? "bg-main border-border"
              : "border-transparent opacity-40 hover:opacity-100 hover:border-border/40",
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      )}
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

// The transcript body, memo'd (2026-07-30 lag hunt): the parent re-renders
// on every composer keystroke / timer tick / poll; unchanged messages must
// not re-reconcile. Props only change when a turn streams or completes.
const TranscriptItems = memo(function TranscriptItems({
  items,
  busy,
  persistedMaxTurn,
  turnText,
  ratings,
  onRate,
}: {
  items: Item[];
  busy: boolean;
  persistedMaxTurn: number;
  turnText: Map<number, string>;
  ratings: Record<number, Rating | null>;
  onRate: (turn: number, r: Rating | null) => void;
}) {
  let prevTurn = 0;
  return (
    <>
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
            {it.type === "tools" ? (
              <ToolGroupRow tools={it.tools} streaming={busy && i === items.length - 1} />
            ) : (
              <MessageItem m={it.msg} />
            )}
            {showFeedback && (
              <FeedbackBar
                rating={ratings[turn] ?? null}
                onRate={(r) => void onRate(turn, r)}
                copyText={turnText.get(turn) ?? null}
              />
            )}
          </div>
        );
      })}
    </>
  );
});

// The composer owns its input state (2026-07-30 lag hunt): keystrokes used
// to setState on the page component and re-render the entire transcript.
// Now a keypress re-renders exactly this row.
function Composer({
  harness,
  busy,
  onSend,
  onStop,
}: {
  harness: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // keep the composer height in sync with its content (also resets it after
  // a send clears the input)
  useEffect(() => {
    autosize(taRef.current);
  }, [input]);
  const submit = () => {
    const t = input.trim();
    if (!t || busy) return;
    setInput("");
    onSend(t);
  };
  return (
    <div className="max-w-3xl mx-auto p-2 flex gap-2 items-end">
      <Textarea
        ref={taRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={`Message ${harness}…`}
        className="flex-1 resize-none min-h-0 max-h-40 text-xs font-mono"
      />
      {busy ? (
        <Button onClick={onStop} variant="neutral" size="sm" title="Stop this turn">
          Stop
        </Button>
      ) : (
        <Button onClick={submit} disabled={!input.trim()} variant="default" size="sm">
          Send
        </Button>
      )}
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
  const [mode, setModeChoice] = useState<ApprovalMode>("ask");
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [harnessMenu, setHarnessMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const breadcrumbSlot =
    typeof document !== "undefined" ? document.getElementById("breadcrumb-actions") : null;

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
      // Persist the chosen approval mode BEFORE the first turn fires, so the
      // opening message already runs under it ("ask" is the backend default).
      if (mode !== "ask") {
        await fetch(`/agent/conversations/${d.conversationId}/mode`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        }).catch(() => {}); // non-fatal: the conversation page can still switch
      }
      // Likewise the model override — set before the first turn so the
      // opening message already runs on the chosen model.
      if (model) {
        await fetch(`/agent/conversations/${d.conversationId}/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model }),
        }).catch(() => {}); // non-fatal: falls back to the harness default
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

  return (
    <div className="h-full min-h-0 flex flex-col items-center justify-center gap-4 p-4">
      <div className="font-heading text-lg">New conversation</div>

      {/* composer row — mirrors the conversation page: one-line auto-grow
          textarea beside a split Send button whose dropdown picks the harness */}
      <div className="w-full max-w-3xl">
        <div className="flex gap-2 items-start">
          <div className="flex-1 min-w-0">
            <Textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autosize(taRef.current);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void start();
                }
              }}
              rows={1}
              autoFocus
              placeholder={`Message ${harness}…`}
              className="w-full resize-none min-h-0 max-h-40 text-xs font-mono"
            />
            {/* mode tabs + model picker under the text box, like the
                conversation page */}
            <div className="pt-2 flex items-start justify-between gap-2">
              <ModeTabs value={mode} onChange={setModeChoice} />
              <ModelPicker harness={harness} value={model} onChange={setModel} />
            </div>
          </div>
          <div className="relative flex shrink-0">
            {/* not visually disabled on empty input — start() already
                no-ops without a message, and the greyed look was noise */}
            <Button
              onClick={() => void start()}
              disabled={busy}
              variant="default"
              size="sm"
              className="rounded-r-none gap-1.5"
              title={`Send to ${HARNESS_LABELS[harness] ?? harness}`}
            >
              <HarnessIcon harness={harness} />
              {busy ? "…" : "Send"}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="rounded-l-none border-l-0 px-1.5"
              title="Choose harness"
              onClick={() => setHarnessMenu((o) => !o)}
            >
              <ChevronRight className={cn("size-3.5 transition-transform", harnessMenu ? "-rotate-90" : "rotate-90")} />
            </Button>
            {harnessMenu && (
              <div className="absolute bottom-full right-0 mb-1.5 z-20 min-w-40 border-2 border-border rounded-base bg-background shadow-shadow overflow-hidden flex flex-col">
                {CHAT_HARNESSES.map((h) => (
                  <button
                    key={h}
                    onClick={() => {
                      setHarness(h);
                      setModel(null); // catalogs differ per harness
                      setHarnessMenu(false);
                      taRef.current?.focus();
                    }}
                    className={cn(
                      "px-3 py-1.5 text-left font-mono text-xs flex items-center gap-2",
                      h === harness
                        ? "bg-main text-main-foreground"
                        : "bg-background hover:bg-secondary-background",
                    )}
                  >
                    <HarnessIcon harness={h} />
                    {HARNESS_LABELS[h] ?? h}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>

      {err && <div className="text-red-600 text-[10px] font-mono">{err}</div>}

      {/* draft settings — cog in the breadcrumb row (top right), modal owns
          the debug toggle */}
      {breadcrumbSlot &&
        createPortal(
          <button
            onClick={() => setSettingsOpen(true)}
            title="Conversation settings"
            className={cn(
              "flex items-center gap-1 rounded-base border-2 px-2 py-1 text-[10px] font-mono uppercase",
              debug ? "bg-main border-border" : "border-border/40 opacity-50 hover:opacity-100",
            )}
          >
            <SettingsIcon className="size-3.5" />
            {debug ? "debug" : null}
          </button>,
          breadcrumbSlot,
        )}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Conversation settings</DialogTitle>
          </DialogHeader>
          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span className="flex flex-col gap-0.5">
              <span className="font-heading text-sm">Debug</span>
              <span className="text-[10px] font-mono opacity-60 max-w-56">
                Dev/test conversation — excluded from the dataset export;
                created jobs/profiles get a [DEBUG] name prefix.
              </span>
            </span>
            <Switch checked={debug} onCheckedChange={setDebug} />
          </label>
        </DialogContent>
      </Dialog>
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
  // response ratings keyed by turn number; synced from the server, then
  // optimistically updated on click
  const [ratings, setRatings] = useState<Record<number, Rating | null>>({});
  // build-scoped defect alerts for this conversation's attached build(s)
  const [alerts, setAlerts] = useState<BuildAlert[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // aborts the in-flight SSE fetch so Stop unsticks the client even if the
  // stream is half-open (e.g. the broker restarted mid-turn)
  const abortRef = useRef<AbortController | null>(null);
  // seconds elapsed in the current turn, for the live activity indicator
  const [elapsed, setElapsed] = useState(0);

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
  // thumb passes null, which clears the row server-side. useCallback: passed
  // into the memo'd transcript, so its identity must be stable.
  const rate = useCallback(async (turn: number, r: Rating | null) => {
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
  }, [id]);

  // Transcript inputs, memo'd (2026-07-30 lag hunt): the parent re-renders on
  // every composer keystroke, elapsed-timer tick, and poll — recomputing the
  // grouping and reconciling the whole transcript made typing visibly laggy
  // on long conversations. These only change when messages actually change.
  const dataMessages = data?.messages;
  const items = useMemo(() => {
    const msgs = dataMessages ?? [];
    return groupMessages(live ? [...msgs, ...live] : msgs);
  }, [dataMessages, live]);
  const turnText = useMemo(() => {
    const m = new Map<number, string>();
    for (const msg of dataMessages ?? []) {
      if (msg.kind === "assistant" && msg.content) {
        const prev = m.get(msg.turn);
        m.set(msg.turn, prev ? `${prev}\n\n${msg.content}` : msg.content);
      }
    }
    return m;
  }, [dataMessages]);
  const persistedMaxTurn = dataMessages?.at(-1)?.turn ?? 0;

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
        if (cancelled) return;
        // bail out when unchanged — a fresh array identity every tick would
        // re-render the page (same trap as the approvals poll)
        setAlerts((prev) => {
          const next = d.alerts ?? [];
          return prev.length === next.length &&
            prev.every((a, i) => a.id === next[i]?.id && a.status === next[i]?.status)
            ? prev
            : next;
        });
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
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/agent/conversations/${id}/approvals`);
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as {
          mode?: ApprovalMode;
          pending?: PendingApproval[];
          modelOverride?: string | null;
        };
        if (cancelled) return;
        setApprovalMode(d.mode ?? "ask");
        // bail out when nothing changed — a fresh array identity every 2 s
        // re-rendered the ENTIRE transcript (every Markdown re-parsed);
        // measured at ~27% main-thread busy on an idle conversation page
        setPendingApprovals((prev) => {
          const next = d.pending ?? [];
          return prev.length === next.length &&
            prev.every((a, i) => a.id === next[i]?.id)
            ? prev
            : next;
        });
        setModelOverride(d.modelOverride ?? null);
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
  const setModel = async (model: string | null) => {
    setModelOverride(model); // optimistic; the poll re-syncs
    try {
      await fetch(`/agent/conversations/${id}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
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

  // text always comes from the caller now — the Composer owns the input
  // state and clears it before invoking us
  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy || !data) return;
    setBusy(true);
    setErr(null);
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

  const { conversation: c, builds } = data;
  // items / turnText / persistedMaxTurn are memo'd above the early returns

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
            <TranscriptItems
              items={items}
              busy={busy}
              persistedMaxTurn={persistedMaxTurn}
              turnText={turnText}
              ratings={ratings}
              onRate={rate}
            />
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
          <Composer
            harness={c.harness}
            busy={busy}
            onSend={(t) => void send(t)}
            onStop={() => void stop()}
          />
          <div className="max-w-3xl mx-auto px-2 pb-2 flex items-start justify-between gap-2">
            <ModeTabs value={approvalMode} onChange={(m) => void setMode(m)} />
            <ModelPicker
              harness={c.harness}
              value={modelOverride}
              observed={c.model}
              onChange={(m) => void setModel(m)}
            />
          </div>
          {err && <div className="max-w-3xl mx-auto px-2 pb-1 text-red-600 text-[10px]">{err}</div>}
        </div>
      )}
    </div>
  );
}
