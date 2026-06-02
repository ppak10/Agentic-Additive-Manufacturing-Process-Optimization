import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Summary {
  builds: number;
  telemetryRows: number;
  events: number;
  frames: number;
  dbSizeBytes: number;
  framesSizeBytes: number;
}

interface Build {
  id: number;
  job_name: string | null;
  phase: string | null;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function fmtDuration(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.round((end - start) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>{label}</CardTitle></CardHeader>
      <CardContent>
        <div className="font-heading text-lg">{value}</div>
      </CardContent>
    </Card>
  );
}

export function Database() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [sumRes, buildsRes] = await Promise.all([
          fetch("/api/summary").then((r) => r.json() as Promise<Summary>),
          fetch("/api/builds").then((r) => r.json() as Promise<Build[]>),
        ]);
        if (!cancelled) {
          setSummary(sumRes);
          setBuilds(buildsRes);
        }
      } catch { /* swallow */ }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tick]);

  return (
    <div className="p-4 grid gap-4">
      <div className="flex items-center gap-3">
        <h2 className="font-heading">Recorded data</h2>
        <button
          className="ml-auto text-xs underline opacity-70 hover:opacity-100"
          onClick={() => setTick((t) => t + 1)}
        >
          refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <SummaryCard label="Builds" value={summary ? fmtNum(summary.builds) : "—"} />
        <SummaryCard label="Telemetry rows" value={summary ? fmtNum(summary.telemetryRows) : "—"} />
        <SummaryCard label="Events" value={summary ? fmtNum(summary.events) : "—"} />
        <SummaryCard label="Frames" value={summary ? fmtNum(summary.frames) : "—"} />
        <SummaryCard label="DB size" value={summary ? fmtBytes(summary.dbSizeBytes) : "—"} />
        <SummaryCard label="Frames on disk" value={summary ? fmtBytes(summary.framesSizeBytes) : "—"} />
      </div>

      <Card>
        <CardHeader><CardTitle>Builds</CardTitle></CardHeader>
        <CardContent>
          {!builds ? (
            <div className="text-sm opacity-60">loading…</div>
          ) : builds.length === 0 ? (
            <div className="text-sm opacity-60">No builds recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left opacity-70 border-b-2 border-border">
                    <th className="py-1 pr-3">id</th>
                    <th className="py-1 pr-3">job</th>
                    <th className="py-1 pr-3">phase</th>
                    <th className="py-1 pr-3">started</th>
                    <th className="py-1 pr-3">duration</th>
                    <th className="py-1 pr-3">status</th>
                    <th className="py-1 pr-3">notes</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {builds.map((b) => (
                    <tr key={b.id} className="border-b border-border/30">
                      <td className="py-1 pr-3 font-heading">{b.id}</td>
                      <td className="py-1 pr-3">{b.job_name ?? "—"}</td>
                      <td className="py-1 pr-3">{b.phase ?? "—"}</td>
                      <td className="py-1 pr-3">{new Date(b.started_at).toLocaleString()}</td>
                      <td className="py-1 pr-3">{fmtDuration(b.started_at, b.ended_at)}</td>
                      <td className="py-1 pr-3">
                        <Badge variant={b.ended_at ? "neutral" : "default"}>
                          {b.ended_at ? "done" : "live"}
                        </Badge>
                      </td>
                      <td className="py-1 pr-3 opacity-70">{b.notes ?? ""}</td>
                      <td className="py-1">
                        <Link
                          to={`/database/${b.id}/replay`}
                          className="text-xs underline opacity-70 hover:opacity-100"
                        >
                          replay
                        </Link>
                      </td>
                    </tr>
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
