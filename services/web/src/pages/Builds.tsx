import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Builds — the human-facing view of the build registry: every recorded
// build joined to its firmware session, job, print profile, telemetry
// summary, and ASTM coverage. The same picture agents get from the
// builds_list MCP tool.

export interface RegistryRow {
  build_id: number;
  started_at: string;
  ended_at: string | null;
  inova_session_id: string | null;
  session_result: number | null;
  job_name: string | null;
  profile_name: string | null;
  print_date: string | null;
  has_astm: boolean;
  n_recoats: number | null;
  n_print_layers: number | null;
  duration_s: number | null;
  laser_on_s: number | null;
  notes: string | null;
}

interface StorageSummary {
  builds: number;
  telemetryRows: number;
  events: number;
  frames: number;
  dbSizeBytes: number;
  framesSizeBytes: number;
}

export const SESSION_RESULT: Record<number, { label: string; variant: "default" | "neutral" }> = {
  0: { label: "incomplete", variant: "neutral" },
  1: { label: "completed", variant: "default" },
  2: { label: "cancelled", variant: "neutral" },
};

export function fmtHours(s: number | null): string {
  if (s == null) return "—";
  const h = s / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(s / 60)} min`;
}

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function Builds() {
  const [rows, setRows] = useState<RegistryRow[] | null>(null);
  const [notWired, setNotWired] = useState(false);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [filter, setFilter] = useState<"all" | "printed" | "astm">("all");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/registry");
        if (res.status === 503 || res.status === 404) {
          if (!cancelled) setNotWired(true);
          return;
        }
        const data = (await res.json()) as RegistryRow[];
        if (!cancelled) {
          setRows(data);
          setNotWired(false);
        }
      } catch {
        /* transient */
      }
      try {
        const s = (await fetch("/api/summary").then((r) => r.json())) as StorageSummary;
        if (!cancelled) setStorage(s);
      } catch {
        /* transient */
      }
    };
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const visible = (rows ?? []).filter((r) =>
    filter === "printed" ? (r.n_print_layers ?? 0) > 0
    : filter === "astm" ? r.has_astm
    : true,
  );

  return (
    <div className="p-4 grid gap-4">
      <div className="flex items-center gap-3">
        <h2 className="font-heading">Builds</h2>
        <div className="ml-auto flex gap-1 text-xs">
          {(["all", "printed", "astm"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded border border-border ${
                filter === f ? "bg-accent" : "opacity-60 hover:opacity-100"
              }`}
            >
              {f === "astm" ? "has ASTM" : f}
            </button>
          ))}
        </div>
      </div>

      {notWired && (
        <Card>
          <CardContent className="py-4 text-sm opacity-70">
            The registry API isn't wired into the recorder yet (pending the
            next maintenance-window restart). Once live, this page shows every
            build joined to its firmware session, job, profile, telemetry
            summary, and ASTM outcomes.
          </CardContent>
        </Card>
      )}

      {!notWired && (
        <Card>
          <CardContent>
            {!rows ? (
              <div className="text-sm opacity-60">loading…</div>
            ) : visible.length === 0 ? (
              <div className="text-sm opacity-60">No builds match.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left opacity-70 border-b-2 border-border">
                      <th className="py-1 pr-3">id</th>
                      <th className="py-1 pr-3">date</th>
                      <th className="py-1 pr-3">job</th>
                      <th className="py-1 pr-3">profile</th>
                      <th className="py-1 pr-3">layers</th>
                      <th className="py-1 pr-3">duration</th>
                      <th className="py-1 pr-3">session</th>
                      <th className="py-1 pr-3">ASTM</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const res = r.session_result != null ? SESSION_RESULT[r.session_result] : null;
                      const live = !r.ended_at;
                      return (
                        <tr key={r.build_id} className="border-b border-border/30 hover:bg-accent/30">
                          <td className="py-1 pr-3 font-heading">
                            <Link to={`/builds/${r.build_id}`} className="underline-offset-2 hover:underline">
                              {r.build_id}
                            </Link>
                          </td>
                          <td className="py-1 pr-3">{new Date(r.started_at).toLocaleDateString()}</td>
                          <td className="py-1 pr-3 max-w-56 truncate">{r.job_name ?? "—"}</td>
                          <td className="py-1 pr-3 max-w-64 truncate">{r.profile_name ?? "—"}</td>
                          <td className="py-1 pr-3">
                            {r.n_print_layers != null
                              ? `${r.n_print_layers} / ${r.n_recoats}`
                              : "—"}
                          </td>
                          <td className="py-1 pr-3">{fmtHours(r.duration_s)}</td>
                          <td className="py-1 pr-3">
                            {live ? (
                              <Badge>live</Badge>
                            ) : res ? (
                              <Badge variant={res.variant}>{res.label}</Badge>
                            ) : (
                              <span className="opacity-50">unlinked</span>
                            )}
                          </td>
                          <td className="py-1 pr-3">{r.has_astm ? "✓" : ""}</td>
                          <td className="py-1 flex gap-2">
                            <Link
                              to={`/builds/${r.build_id}`}
                              className="text-xs underline opacity-70 hover:opacity-100"
                            >
                              card
                            </Link>
                            <Link
                              to={`/builds/${r.build_id}/replay`}
                              className="text-xs underline opacity-70 hover:opacity-100"
                            >
                              replay
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {storage && (
        <div className="text-xs opacity-60">
          storage: {storage.builds} builds · {new Intl.NumberFormat().format(storage.telemetryRows)} telemetry rows ·{" "}
          {new Intl.NumberFormat().format(storage.frames)} frames · db {fmtBytes(storage.dbSizeBytes)} · frames on disk{" "}
          {fmtBytes(storage.framesSizeBytes)}
        </div>
      )}
    </div>
  );
}
