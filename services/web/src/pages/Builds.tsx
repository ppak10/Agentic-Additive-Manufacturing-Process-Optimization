import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, RefreshCw, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useTasks } from "@/hooks/useTasks";
import { useBuildStatus, type BuildArtifacts } from "@/hooks/useBuildStatus";

// Dataset-artifact readout for a build: one dot per pipeline output, green when
// the file exists in the Telemetry dataset. Tooltip spells it out.
const ART_KEYS: { key: keyof BuildArtifacts; label: string }[] = [
  { key: "telemetry", label: "telemetry" },
  { key: "frames", label: "frames" },
  { key: "labels", label: "labels" },
  { key: "ticks", label: "ticks" },
  { key: "peregrine", label: "peregrine" },
];

function ArtifactDots({ a }: { a?: BuildArtifacts }) {
  if (!a) return <span className="text-[10px] opacity-30">…</span>;
  const title = ART_KEYS.map((k) => `${k.label} ${a[k.key] ? "✓" : "✗"}`).join(" · ");
  return (
    <span className="inline-flex items-center gap-0.5" title={title}>
      {ART_KEYS.map((k) => (
        <span
          key={k.key}
          className={cn("size-2 rounded-full border border-border", a[k.key] && "bg-green-500")}
        />
      ))}
    </span>
  );
}

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

// ── sortable column header (same pattern as Jobs.tsx) ─────────────────────────

type SortKey = "build_id" | "started_at" | "job_name" | "profile_name" | "n_print_layers" | "duration_s";
type SortDir = 1 | -1;

function SortHead({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead className={cn("h-8 px-2", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex w-full items-center gap-1 text-xs font-heading"
      >
        {label}
        {active ? (
          sort.dir === 1 ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />
        ) : (
          <ArrowUpDown className="size-3 shrink-0 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

export function Builds() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<RegistryRow[] | null>(null);
  const [notWired, setNotWired] = useState(false);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [query, setQuery] = useState("");
  // Dataset artifact status + one-click per-build refresh (runs refresh_build
  // through the tasks service). activeFor() reflects a pending/running task so
  // the button becomes a spinner instead of double-queuing.
  const { list: tasks, createTask } = useTasks();
  const artifacts = useBuildStatus((rows ?? []).map((r) => r.build_id));
  const [triggerErr, setTriggerErr] = useState<string | null>(null);
  const handleRefresh = async (buildId: number) => {
    setTriggerErr(null);
    try {
      await createTask("refresh_build", { build_id: buildId });
    } catch (e) {
      setTriggerErr((e as Error).message ?? String(e));
    }
  };
  const activeFor = (buildId: number) =>
    tasks?.find((t) => t.build_id === buildId && (t.status === "pending" || t.status === "running"));
  // Sortable + paginated, newest build first by default; text columns default
  // ascending on first click (same convention as the Jobs data-table).
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "build_id", dir: -1 });
  const handleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: (s.dir * -1) as SortDir }
        : { key, dir: key === "job_name" || key === "profile_name" ? 1 : -1 },
    );
    setPage(0);
  };

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

  const q = query.trim().toLowerCase();
  const filtered = (rows ?? []).filter((r) =>
    q === "" ||
    String(r.build_id).includes(q) ||
    (r.job_name ?? "").toLowerCase().includes(q) ||
    (r.profile_name ?? "").toLowerCase().includes(q) ||
    (r.notes ?? "").toLowerCase().includes(q),
  );
  const sorted = [...filtered].sort((a, b) => {
    let cmp: number;
    switch (sort.key) {
      case "started_at":
        cmp = new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
        break;
      case "job_name":
        cmp = (a.job_name ?? "").localeCompare(b.job_name ?? "");
        break;
      case "profile_name":
        cmp = (a.profile_name ?? "").localeCompare(b.profile_name ?? "");
        break;
      case "n_print_layers":
        cmp = (a.n_print_layers ?? 0) - (b.n_print_layers ?? 0);
        break;
      case "duration_s":
        cmp = (a.duration_s ?? 0) - (b.duration_s ?? 0);
        break;
      default:
        cmp = a.build_id - b.build_id;
    }
    return cmp * sort.dir;
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 opacity-50" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search id / job / profile…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        {triggerErr && <span className="text-xs text-red-600 dark:text-red-400">{triggerErr}</span>}
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
        <>
          {!rows ? (
            <div className="text-sm opacity-60">loading…</div>
          ) : sorted.length === 0 ? (
            <div className="text-sm opacity-60">No builds match.</div>
          ) : (
            <div className="flex flex-col min-h-0 border-2 border-border [&>div]:min-h-0">
              <Table className="table-fixed border-0">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <SortHead label="id" sortKey="build_id" sort={sort} onSort={handleSort} className="w-16" />
                    <SortHead label="date" sortKey="started_at" sort={sort} onSort={handleSort} className="w-28" />
                    <SortHead label="job" sortKey="job_name" sort={sort} onSort={handleSort} />
                    <SortHead label="profile" sortKey="profile_name" sort={sort} onSort={handleSort} />
                    <SortHead label="layers" sortKey="n_print_layers" sort={sort} onSort={handleSort} className="w-20" />
                    <SortHead label="duration" sortKey="duration_s" sort={sort} onSort={handleSort} className="w-24" />
                    <TableHead className="h-8 px-2 text-xs font-heading w-28">session</TableHead>
                    <TableHead className="h-8 px-2 text-xs font-heading w-36">dataset</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((r) => {
                    const res = r.session_result != null ? SESSION_RESULT[r.session_result] : null;
                    const live = !r.ended_at;
                    return (
                      <TableRow
                        key={r.build_id}
                        onClick={() => navigate(`/builds/${r.build_id}`)}
                        className="cursor-pointer bg-background text-foreground hover:bg-secondary-background"
                      >
                        <TableCell className="px-2 py-1.5 text-xs font-heading">{r.build_id}</TableCell>
                        <TableCell className="px-2 py-1.5 text-xs whitespace-nowrap">
                          {new Date(r.started_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-xs truncate" title={r.job_name ?? undefined}>
                          {r.job_name ?? "—"}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-xs truncate" title={r.profile_name ?? undefined}>
                          {r.profile_name ?? "—"}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-xs">
                          {r.n_print_layers != null ? `${r.n_print_layers} / ${r.n_recoats}` : "—"}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-xs whitespace-nowrap">{fmtHours(r.duration_s)}</TableCell>
                        <TableCell className="px-2 py-1.5 text-xs">
                          {live ? (
                            <Badge>live</Badge>
                          ) : res ? (
                            <Badge variant={res.variant}>{res.label}</Badge>
                          ) : (
                            <span className="opacity-50">unlinked</span>
                          )}
                        </TableCell>
                        <TableCell className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <ArtifactDots a={artifacts[r.build_id]} />
                            {activeFor(r.build_id) ? (
                              <span className="inline-flex items-center gap-1 text-[10px] opacity-70">
                                <Loader2 className="size-3 animate-spin" /> running
                              </span>
                            ) : (
                              <Button
                                variant="neutral"
                                size="sm"
                                className="h-6 px-1.5"
                                title="Refresh this build's dataset (export → summarize → labels → frames → ticks → peregrine)"
                                onClick={() => void handleRefresh(r.build_id)}
                              >
                                <RefreshCw className="size-3" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* data-table footer — page indicator + prev/next (see neobrutalism
              data-table demo; same as Jobs.tsx) */}
          {pageCount > 1 && (
            <div className="flex items-center gap-2 shrink-0">
              <div className="text-xs opacity-60 mr-auto">
                Page {safePage + 1} of {pageCount} · {sorted.length} builds
              </div>
              <Button
                variant="noShadow"
                size="sm"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="noShadow"
                size="sm"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      {storage && (
        <div className="text-xs opacity-60 shrink-0">
          storage: {storage.builds} builds · {new Intl.NumberFormat().format(storage.telemetryRows)} telemetry rows ·{" "}
          {new Intl.NumberFormat().format(storage.frames)} frames · db {fmtBytes(storage.dbSizeBytes)} · frames on disk{" "}
          {fmtBytes(storage.framesSizeBytes)}
        </div>
      )}
    </div>
  );
}
