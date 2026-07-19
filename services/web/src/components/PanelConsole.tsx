import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Markdown } from "@/components/Markdown";
import { sonarPing, pushNotify, requestNotifyPermission } from "@/lib/sonar";

// Panel-mode console (wiki/Panel-Mode.md) — Mission Control's agent
// surface, replacing the single-harness sidebar chat. One long-running
// console conversation, independent of builds: operator turns and
// event-injected DATA turns fan out to the four harnesses; candidates
// render blinded as A-D; the operator selects one or types their own
// response (user_authored — the strongest label). Identities reveal only
// after the selection is persisted.

type PanelMsg = { role: "operator" | "data" | "advisor" | "note"; text: string };
type PanelCandidate = { slot: string; text: string };
type PanelState = {
  id: string;
  turn: number;
  busy: boolean;
  console: boolean;
  enabled: string[];
  transcript: PanelMsg[];
  pending: { turn: number; stimulusEventId: number | null; candidates: PanelCandidate[] } | null;
  lastSelection: {
    turn: number;
    outcome: string;
    revealed: { slot: string; harness: string; model: string | null }[];
  } | null;
};

const ROLE_STYLE: Record<PanelMsg["role"], string> = {
  operator: "bg-secondary-background border-border",
  data: "bg-amber-100 dark:bg-amber-950 border-amber-500",
  advisor: "bg-background border-border",
  note: "bg-transparent border-transparent opacity-60 text-center",
};

const ROLE_TAG: Record<PanelMsg["role"], string> = {
  operator: "you",
  data: "printer data",
  advisor: "advisor (selected)",
  note: "",
};

export function PanelConsole() {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const panelIdRef = useRef<string | null>(null);
  const prevPendingTurn = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Attach to the console panel (the one the event watcher feeds),
  // creating it if the broker hasn't yet.
  const attach = useCallback(async (): Promise<string | null> => {
    try {
      const list = (await fetch("/agent/panel").then((r) => r.json())) as PanelState[];
      const existing = list.find((p) => p.console);
      if (existing) return existing.id;
      const created = (await fetch("/agent/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ console: true }),
      }).then((r) => r.json())) as PanelState;
      return created.id;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!panelIdRef.current) panelIdRef.current = await attach();
      const id = panelIdRef.current;
      if (!id || cancelled) return;
      try {
        const r = await fetch(`/agent/panel/${id}`);
        if (r.status === 404) {
          // broker restarted — its in-memory panel map is gone; reattach
          panelIdRef.current = null;
          return;
        }
        const state = (await r.json()) as PanelState;
        if (cancelled) return;
        setPanel(state);
        setError(null);
        // sonar + push on a NEW candidate set awaiting selection
        if (state.pending && state.pending.turn !== prevPendingTurn.current) {
          prevPendingTurn.current = state.pending.turn;
          sonarPing();
          pushNotify(
            "Inova: advisor responses ready",
            `Turn ${state.pending.turn}: ${state.pending.candidates.length} candidates await your selection.`,
          );
        }
      } catch {
        if (!cancelled) setError("broker unreachable");
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [attach]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [panel?.transcript.length, panel?.pending?.turn, panel?.busy]);

  const post = async (path: string, body: unknown) => {
    const id = panelIdRef.current;
    if (!id) return;
    requestNotifyPermission(); // piggyback on a real user gesture
    try {
      const r = await fetch(`/agent/panel/${id}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) setError((await r.json())?.error ?? `HTTP ${r.status}`);
      else setError(null);
    } catch {
      setError("broker unreachable");
    }
  };

  const sendTurn = () => {
    const text = input.trim();
    if (!text || !panel || panel.busy) return;
    setInput("");
    if (panel.pending) {
      // typing while candidates are pending = your own response wins
      void post("/select", { outcome: "user_authored", userText: text });
    } else {
      void post("/turn", { text });
    }
  };

  const pending = panel?.pending ?? null;

  return (
    <div className="h-full min-h-0 flex flex-col font-mono text-xs">
      {/* transcript */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {panel?.transcript.length === 0 && !panel.busy && !pending && (
          <div className="opacity-40 text-center mt-4">
            Console conversation — spans builds; printer events land here
            automatically and fan out to the four harnesses. Type below to ask
            the panel yourself.
          </div>
        )}
        {panel?.transcript.map((m, i) =>
          m.role === "data" ? (
            // printer-injected DATA turns get the library Alert treatment —
            // they ARE alerts (defect verdicts, build events), amber-tinted
            <Alert key={i} className="bg-amber-300 text-black py-2 px-3">
              <AlertTitle className="text-[9px] uppercase tracking-wider opacity-60">
                printer data
              </AlertTitle>
              <AlertDescription className="whitespace-pre-wrap text-xs font-mono text-black">
                {m.text}
              </AlertDescription>
            </Alert>
          ) : (
            <div
              key={i}
              className={cn(
                "border-2 rounded px-2 py-1.5",
                m.role === "advisor" ? "" : "whitespace-pre-wrap",
                ROLE_STYLE[m.role],
              )}
            >
              {ROLE_TAG[m.role] && (
                <div className="text-[9px] uppercase tracking-wider opacity-50 mb-0.5">{ROLE_TAG[m.role]}</div>
              )}
              {m.role === "advisor" ? <Markdown text={m.text} /> : m.text}
            </div>
          ),
        )}

        {panel?.busy && (
          <div className="border-2 border-dashed border-border rounded px-2 py-3 text-center animate-pulse">
            {panel.enabled?.length ?? 4} advisors thinking…
          </div>
        )}

        {pending && (
          <div className="flex flex-col gap-2">
            <div className="text-[9px] uppercase tracking-wider opacity-50">
              candidate responses — pick one, or type your own below
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
              {pending.candidates.map((c) => (
                <div key={c.slot} className="border-2 border-border rounded-base shadow-shadow bg-background flex flex-col">
                  <div className="flex items-center justify-between px-2 py-1 border-b-2 border-border bg-secondary-background">
                    <Badge variant="neutral">{c.slot}</Badge>
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void post("/select", { outcome: "chosen", slot: c.slot })}
                    >
                      Select
                    </Button>
                  </div>
                  <div className="p-2 max-h-48 overflow-y-auto">
                    <Markdown text={c.text} />
                  </div>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="neutral"
              className="self-start h-6 px-2 text-[10px] opacity-70 hover:opacity-100"
              onClick={() => void post("/select", { outcome: "none" })}
            >
              None are good
            </Button>
          </div>
        )}

        {panel?.lastSelection && !pending && (
          <div className="text-[9px] opacity-50">
            turn {panel.lastSelection.turn}: {panel.lastSelection.outcome}
            {" · "}
            {panel.lastSelection.revealed.map((r) => `${r.slot}=${r.harness}`).join(" ")}
          </div>
        )}
      </div>

      {/* input */}
      <div className="border-t-2 border-border p-2 flex gap-2 items-end shrink-0">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendTurn();
            }
          }}
          rows={2}
          placeholder={pending ? "…or type your own response (user-authored)" : "Ask the panel…"}
          className="flex-1 resize-none min-h-0 text-xs font-mono"
        />
        <Button
          onClick={sendTurn}
          disabled={!input.trim() || panel?.busy}
          variant="default"
          size="sm"
        >
          {pending ? "Respond" : "Send"}
        </Button>
      </div>
      {error && <div className="px-2 pb-1 text-red-600 text-[10px]">{error}</div>}
    </div>
  );
}
