import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Read-only conversation viewer — the sidebar's Conversations list links
// here. Renders the normalized agent_messages transcript: user/event turns,
// assistant text, tool calls/results, meta lines.

interface Msg {
  turn: number;
  seq: number;
  ts: string;
  kind: string;
  content: string | null;
  tool_name: string | null;
  is_error: boolean | null;
}

interface ConversationData {
  conversation: {
    id: number;
    created_at: string;
    harness: string;
    role: string;
    model: string | null;
    preset: string | null;
  };
  messages: Msg[];
  builds: number[];
}

const KIND_STYLE: Record<string, string> = {
  user: "bg-secondary-background border-border",
  event: "bg-amber-100 dark:bg-amber-950 border-amber-500",
  context: "bg-secondary-background border-border opacity-70",
  assistant: "bg-background border-border",
  tool_call: "bg-background border-border/50 opacity-70 font-mono text-[10px]",
  tool_result: "bg-background border-border/50 opacity-50 font-mono text-[10px]",
  meta: "bg-transparent border-transparent opacity-50 text-center",
};

export function ConversationPage() {
  const { id } = useParams();
  const [data, setData] = useState<ConversationData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/agent/conversations/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (err) return <div className="p-4 text-xs text-red-600">Failed to load conversation {id}: {err}</div>;
  if (!data) return <div className="p-4 text-xs opacity-60">Loading conversation…</div>;

  const { conversation: c, messages, builds } = data;
  return (
    <div className="p-4 max-w-3xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm flex-wrap">
            <span>Conversation {c.id}</span>
            <Badge variant="neutral">{c.role}</Badge>
            <Badge variant="neutral">{c.harness}</Badge>
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
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 font-mono text-xs">
          {messages.length === 0 && <div className="opacity-50">No messages recorded.</div>}
          {messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                "border-2 rounded-base px-2 py-1.5 whitespace-pre-wrap break-words",
                KIND_STYLE[m.kind] ?? "border-border",
                m.is_error && "border-red-500",
              )}
            >
              <div className="text-[9px] uppercase tracking-wider opacity-50 mb-0.5">
                turn {m.turn} · {m.kind}
                {m.tool_name && ` · ${m.tool_name}`}
              </div>
              {m.content ?? (m.tool_name ? "(tool input recorded)" : "")}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
