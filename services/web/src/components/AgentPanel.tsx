import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Send, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Copilot-style docked chat panel. Lives in the App shell (outside the
// router) so the conversation survives navigation; talks to the agent
// broker (harness/server.ts) via /agent, streaming turns over SSE.

const HARNESSES = ["claude", "opencode", "codex", "agy"] as const;
type Harness = (typeof HARNESSES)[number];

interface ToolCall {
  name: string;
  input: unknown;
  result?: string;
}

interface Msg {
  role: "user" | "assistant" | "tool" | "meta";
  text?: string;
  tool?: ToolCall;
}

export function AgentPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const location = useLocation();
  const [harness, setHarness] = useState<Harness>("claude");
  const [operator, setOperator] = useState(false);
  const [attachContext, setAttachContext] = useState(true);
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  const reset = () => {
    setChatId(null);
    setMsgs([]);
  };

  const toggleOperator = () => {
    if (!operator) {
      const ok = window.confirm(
        "Operator mode gives the agent FULL control tools (recoater passes, " +
          "layer overrides) on the live printer. Enable for this chat?",
      );
      if (!ok) return;
    }
    setOperator((o) => !o);
    reset(); // preset is fixed per chat — new chat on change
  };

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: message }]);

    try {
      let id = chatId;
      if (!id) {
        const res = await fetch("/agent/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harness,
            preset: operator ? "operator" : "analyst",
          }),
        });
        if (!res.ok) throw new Error(`broker: HTTP ${res.status}`);
        id = ((await res.json()) as { chatId: string }).chatId;
        setChatId(id);
      }

      const context = attachContext
        ? `User is viewing dashboard page ${location.pathname}`
        : undefined;
      const res = await fetch(`/agent/chats/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, context }),
      });
      if (!res.ok || !res.body) throw new Error(`broker: HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!frame.startsWith("data: ")) continue;
          const ev = JSON.parse(frame.slice(6));
          setMsgs((m) => {
            const next = [...m];
            if (ev.type === "text" && ev.text) {
              next.push({ role: "assistant", text: ev.text });
            } else if (ev.type === "tool") {
              next.push({
                role: "tool",
                tool: { name: ev.name, input: ev.input },
              });
            } else if (ev.type === "tool_result") {
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].role === "tool" && !next[i].tool!.result) {
                  next[i] = {
                    ...next[i],
                    tool: { ...next[i].tool!, result: ev.text },
                  };
                  break;
                }
              }
            } else if (ev.type === "done") {
              next.push({
                role: "meta",
                text: `turn ${ev.turn} · ${ev.toolCalls} tools · ${ev.tokensIn ?? "?"}/${ev.tokensOut ?? "?"} tok`,
              });
            } else if (ev.type === "error") {
              next.push({ role: "meta", text: `error: ${ev.message}` });
            }
            return next;
          });
        }
      }
    } catch (err) {
      setMsgs((m) => [
        ...m,
        {
          role: "meta",
          text: `${(err as Error).message} — is the broker running? (npx tsx harness/server.ts)`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className={
        embedded
          ? "flex flex-col h-full min-h-0 w-full bg-background"
          : "w-96 shrink-0 border-l-2 border-border bg-background flex flex-col h-svh sticky top-0"
      }
    >
      <div className="flex items-center gap-2 border-b-2 border-border px-2 py-2">
        <select
          className="text-xs bg-background border-2 border-border rounded px-1 py-0.5"
          value={harness}
          disabled={!!chatId}
          onChange={(e) => setHarness(e.target.value as Harness)}
        >
          {HARNESSES.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
        <button
          onClick={toggleOperator}
          title="Analyst = read-only tools. Operator = full printer control."
        >
          <Badge variant={operator ? "default" : "neutral"}>
            {operator ? "operator" : "analyst"}
          </Badge>
        </button>
        <Button variant="neutral" size="sm" className="ml-auto h-7 px-2" onClick={reset} title="New chat">
          <Plus className="size-3" />
        </Button>
        {onClose && (
          <Button variant="neutral" size="sm" className="h-7 px-2" onClick={onClose} title="Close panel">
            <X className="size-3" />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 grid gap-2 content-start">
        {msgs.length === 0 && (
          <div className="text-xs opacity-50 p-2">
            Ask about builds, ASTM outcomes, profiles, or the live print.
            The agent has the same tools as the headless harnesses.
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "tool" ? (
            <details key={i} className="text-xs border-2 border-border rounded px-2 py-1 bg-secondary-background">
              <summary className="cursor-pointer font-mono">
                🔧 {m.tool!.name.replace("mcp__agentic-sls__", "")}
                <span className="opacity-50"> {JSON.stringify(m.tool!.input)?.slice(0, 60)}</span>
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-all opacity-70 max-h-40 overflow-y-auto">
                {m.tool!.result ?? "…"}
              </pre>
            </details>
          ) : m.role === "meta" ? (
            <div key={i} className="text-[10px] opacity-40 text-center">{m.text}</div>
          ) : (
            <div
              key={i}
              className={`text-xs whitespace-pre-wrap rounded border-2 border-border px-2 py-1.5 ${
                m.role === "user" ? "bg-main text-main-foreground ml-6" : "bg-background mr-2"
              }`}
            >
              {m.text}
            </div>
          ),
        )}
        {busy && <div className="text-xs opacity-50 animate-pulse px-2">thinking…</div>}
      </div>

      <div className="border-t-2 border-border p-2 grid gap-1">
        <div className="flex gap-2">
          <textarea
            className="flex-1 text-xs bg-background border-2 border-border rounded p-1.5 resize-none h-14"
            placeholder={`Message ${harness}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button size="sm" className="self-end h-8" disabled={busy || !input.trim()} onClick={() => void send()}>
            <Send className="size-3" />
          </Button>
        </div>
        <label className="text-[10px] opacity-60 flex items-center gap-1">
          <input
            type="checkbox"
            checked={attachContext}
            onChange={(e) => setAttachContext(e.target.checked)}
          />
          attach page context ({location.pathname})
        </label>
      </div>
    </aside>
  );
}
