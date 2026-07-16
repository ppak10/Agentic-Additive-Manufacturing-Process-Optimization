import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Agents — the record of every harness session: GUI chats, headless smoke
// runs, and (later) watchdog/reflector invocations. Served by the agent
// broker; each row is thesis data (harness × model × role × outcome).

interface SessionRow {
  id: number;
  started_at: string;
  ended_at: string;
  harness: string;
  model: string | null;
  role: string;
  build_id: number | null;
  tool_calls: number | null;
  turns: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  exit_code: number | null;
  prompt: string | null;
  result: string | null;
}

interface SessionDetail {
  session: SessionRow & { transcript_path: string | null };
  transcript: string | null;
  stderr: string | null;
}

function Detail({ id }: { id: number }) {
  const [d, setD] = useState<SessionDetail | null>(null);
  useEffect(() => {
    fetch(`/agent/sessions/${id}`)
      .then((r) => r.json())
      .then(setD)
      .catch(() => setD(null));
  }, [id]);
  if (!d) return <div className="text-xs opacity-60 p-2">loading…</div>;
  return (
    <div className="grid gap-2 p-2 text-xs">
      {d.session.prompt && (
        <div>
          <span className="opacity-60">prompt:</span> {d.session.prompt}
        </div>
      )}
      {d.session.result && (
        <div className="whitespace-pre-wrap border-2 border-border rounded p-2">
          {d.session.result}
        </div>
      )}
      {d.transcript && (
        <details>
          <summary className="cursor-pointer opacity-70">raw transcript (tail)</summary>
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all text-[10px] opacity-70">
            {d.transcript}
          </pre>
        </details>
      )}
      {d.stderr && (
        <details>
          <summary className="cursor-pointer opacity-70">stderr</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] opacity-70">
            {d.stderr}
          </pre>
        </details>
      )}
    </div>
  );
}

export function Agents() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [harnessFilter, setHarnessFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/agent/sessions")
        .then(async (r) => {
          if (!r.ok) throw new Error(`broker unreachable (HTTP ${r.status}) — start it with: npx tsx harness/server.ts`);
          return r.json() as Promise<SessionRow[]>;
        })
        .then((d) => {
          if (!cancelled) {
            setRows(d);
            setError(null);
          }
        })
        .catch((e) => !cancelled && setError(String(e.message ?? e)));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const harnesses = ["all", ...new Set((rows ?? []).map((r) => r.harness))];
  const visible = (rows ?? []).filter(
    (r) => harnessFilter === "all" || r.harness === harnessFilter,
  );

  return (
    <div className="p-4 grid gap-4">
      <div className="flex items-center gap-3">
        <h2 className="font-heading">Agent sessions</h2>
        <div className="ml-auto flex gap-1 text-xs">
          {harnesses.map((h) => (
            <button
              key={h}
              onClick={() => setHarnessFilter(h)}
              className={`px-2 py-1 rounded border border-border ${
                harnessFilter === h ? "bg-accent" : "opacity-60 hover:opacity-100"
              }`}
            >
              {h}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent>
          {error ? (
            <div className="text-sm opacity-70 py-2">{error}</div>
          ) : !rows ? (
            <div className="text-sm opacity-60">loading…</div>
          ) : visible.length === 0 ? (
            <div className="text-sm opacity-60">No sessions recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left opacity-70 border-b-2 border-border">
                    <th className="py-1 pr-3">id</th>
                    <th className="py-1 pr-3">time</th>
                    <th className="py-1 pr-3">harness</th>
                    <th className="py-1 pr-3">model</th>
                    <th className="py-1 pr-3">role</th>
                    <th className="py-1 pr-3">tools</th>
                    <th className="py-1 pr-3">tokens</th>
                    <th className="py-1 pr-3">exit</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <>
                      <tr
                        key={r.id}
                        className="border-b border-border/30 cursor-pointer hover:bg-accent/30"
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                      >
                        <td className="py-1 pr-3 font-heading">{r.id}</td>
                        <td className="py-1 pr-3">{new Date(r.started_at).toLocaleString()}</td>
                        <td className="py-1 pr-3">
                          <Badge variant="neutral">{r.harness}</Badge>
                        </td>
                        <td className="py-1 pr-3 max-w-40 truncate">{r.model ?? "—"}</td>
                        <td className="py-1 pr-3">{r.role}</td>
                        <td className="py-1 pr-3">{r.tool_calls ?? "—"}</td>
                        <td className="py-1 pr-3">
                          {r.tokens_in != null ? `${r.tokens_in}/${r.tokens_out}` : "—"}
                        </td>
                        <td className="py-1 pr-3">
                          {r.exit_code === 0 ? "0" : <span className="text-red-500">{r.exit_code}</span>}
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr key={`${r.id}-detail`}>
                          <td colSpan={8} className="border-b border-border/30 bg-secondary-background/50">
                            <Detail id={r.id} />
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
