import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type JobDetail, useJobs } from "@/hooks/useJobs";
import { useJobInstances } from "@/hooks/useJobInstances";
import { usePrintProfiles } from "@/hooks/usePrintProfiles";
import { JobBuild3D, PartViewer3D } from "@/panels/JobPreview3D";

// ── helpers ───────────────────────────────────────────────────────────────────

const JOB_TYPE_LABELS: Record<string, string> = {
  Automatic: "Print",
  Profiling: "Profiling",
  AnalyseHeating: "Analyse",
  PowderTuning: "Powder tuning",
  Custom: "Custom",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ── breadcrumb-row actions portal ─────────────────────────────────────────────

// The slot div lives in the app shell (App.tsx); it isn't in the DOM until
// after the first commit, so resolve it in an effect.
function BreadcrumbActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("breadcrumb-actions"));
  }, []);
  return target ? createPortal(children, target) : null;
}

// ── sortable column header ────────────────────────────────────────────────────

type SortKey = "name" | "createdAt";
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

// ── input styles (shared with Print Profiles page) ────────────────────────────

const inputCls =
  "border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground text-xs disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main";

// ── detail / edit panel ───────────────────────────────────────────────────────

function DetailPanel({
  job,
  onSave,
  onDelete,
}: {
  job: JobDetail;
  onSave: (patch: { name?: string; printProfileId?: string | null }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { list: profiles } = usePrintProfiles();

  const [name, setName] = useState(job.name);
  const [profileId, setProfileId] = useState<string>(job.printProfileId ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 3D preview: the stored nesting solution + which object file the part
  // viewer shows (row click / instance click selects by mesh hash).
  const { chamber, instances, unavailable } = useJobInstances(job.id);
  const [selectedHash, setSelectedHash] = useState<string | null>(
    job.objectFiles[0]?.hash ?? null,
  );

  // Reset when a different job is loaded.
  const jobId = job.id;
  useEffect(() => {
    setName(job.name);
    setProfileId(job.printProfileId ?? "");
    setError(null);
    setConfirmDelete(false);
    setSelectedHash(job.objectFiles[0]?.hash ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const isDirty = name !== job.name || (profileId || null) !== job.printProfileId;

  const save = async () => {
    if (!name.trim()) { setError("Name cannot be empty"); return; }
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; printProfileId?: string | null } = {};
      if (name.trim() !== job.name) patch.name = name.trim();
      if ((profileId || null) !== job.printProfileId)
        patch.printProfileId = profileId || null;
      await onSave(patch);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError((e as Error).message ?? String(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const selectedProfileName = profiles?.find((p) => p.id === profileId)?.name;

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* action bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={name}
          className={cn(inputCls, "flex-1 min-w-0 text-sm font-heading")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        />
        <Button size="sm" onClick={() => void save()} disabled={saving || deleting || !isDirty}>
          {saving ? <Loader2 className="size-3 animate-spin" /> : null}
          Save
        </Button>
        {confirmDelete ? (
          <>
            <span className="text-xs opacity-70">Delete this job?</span>
            <Button size="sm" variant="neutral" onClick={() => void doDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              Confirm
            </Button>
            <Button size="sm" variant="neutral" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="neutral" onClick={() => setConfirmDelete(true)} disabled={saving || deleting}>
            <Trash2 className="size-3" />
          </Button>
        )}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>

      {/* metadata strip */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 text-xs">
        {/* profile assignment */}
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest opacity-50">Print Profile</div>
          <div className="flex items-center gap-2">
            <select
              value={profileId}
              title={selectedProfileName}
              className={cn(inputCls, "w-auto min-w-[160px]")}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">(none)</option>
              {profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            {!profiles && <span className="opacity-40 text-[10px]">loading profiles…</span>}
          </div>
        </div>

        <div className="text-[10px] opacity-60">
          <span className="uppercase tracking-widest block mb-0.5">Type</span>
          <span>{JOB_TYPE_LABELS[job.type] ?? job.type}</span>
        </div>
        <div className="text-[10px] opacity-60">
          <span className="uppercase tracking-widest block mb-0.5">Created</span>
          <span>{formatDate(job.createdAt)}</span>
        </div>
        {job.nestingState?.availableDepth != null && (
          <div className="text-[10px] opacity-60">
            <span className="uppercase tracking-widest block mb-0.5">Available depth</span>
            <span>{job.nestingState.availableDepth} mm</span>
          </div>
        )}
        {job.nestingState?.sinteredVolume != null && (
          <div className="text-[10px] opacity-60">
            <span className="uppercase tracking-widest block mb-0.5">Sintered volume</span>
            <span>{job.nestingState.sinteredVolume?.toFixed(1)} cm³</span>
          </div>
        )}
        {/* needsLaser/previewEnabled stay hidden — read-only firmware flags
            the GUI can't change; dry print is the one worth flagging */}
        {job.dryPrintEnabled && (
          <span className="border-2 border-border px-1.5 py-0.5 rounded-base opacity-70 text-[10px]">dry print</span>
        )}
      </div>

      {/* 3D preview: whole build left, selected part right */}
      <div className="grid grid-cols-2 gap-4 h-[340px] shrink-0">
        <div className="border-2 border-border overflow-hidden relative">
          {unavailable ? (
            <div className="p-3 text-xs opacity-50">
              Build preview needs the updated Inova plugin (/jobs/&#123;id&#125;/instances).
            </div>
          ) : instances === null ? (
            <div className="p-3 text-xs opacity-50">loading build…</div>
          ) : instances.length === 0 ? (
            <div className="p-3 text-xs opacity-50">This job has no nested instances.</div>
          ) : (
            <JobBuild3D
              jobId={job.id}
              chamber={chamber}
              instances={instances}
              selectedHash={selectedHash}
              onSelectHash={setSelectedHash}
            />
          )}
        </div>
        <div className="border-2 border-border overflow-hidden">
          <PartViewer3D jobId={job.id} hash={selectedHash} />
        </div>
      </div>

      {/* parts list — same treatment as the sidebar data-table; row click
          drives the part viewer + build-view highlight */}
      <div className="flex flex-col gap-1 text-xs flex-1 min-h-0">
        <div className="text-[10px] uppercase tracking-widest opacity-50">
          Parts ({job.objectFiles.length})
        </div>
        {job.objectFiles.length > 0 ? (
          <div className="flex flex-col min-h-0 border-2 border-border [&>div]:min-h-0">
            <Table className="table-fixed border-0">
              <TableBody>
                {job.objectFiles.map((f) => (
                  <TableRow
                    key={f.id}
                    data-state={f.hash === selectedHash ? "selected" : undefined}
                    onClick={() => setSelectedHash(f.hash)}
                    className="cursor-pointer bg-background text-foreground hover:bg-secondary-background data-[state=selected]:bg-main data-[state=selected]:text-main-foreground"
                  >
                    <TableCell className="px-3 py-1.5 text-xs font-heading truncate" title={f.name}>
                      {f.name}
                    </TableCell>
                    <TableCell className="px-3 py-1.5 text-[10px] w-[70px]">
                      ×{instances?.filter((i) => i.hash === f.hash).length ?? "?"}
                    </TableCell>
                    <TableCell className="px-3 py-1.5 text-[10px] font-mono opacity-40 w-[110px]">
                      {f.hash?.slice(0, 8)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-[10px] opacity-40">No mesh files attached.</div>
        )}
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function Jobs() {
  const { list, listError, refresh, refreshing, fetchJob, updateJob, deleteJob } = useJobs();

  // Selection lives in the route (/jobs/:id) so the breadcrumb, deep links,
  // and the back button all reflect it; the job name rides along in
  // location.state.breadcrumb for the crumb label.
  const { id } = useParams();
  const selectedId = id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [detailTick, setDetailTick] = useState(0);

  // Load job when selection changes (or a manual refresh bumps detailTick).
  useEffect(() => {
    if (!selectedId) { setJob(null); return; }
    let cancelled = false;
    setJobLoading(true);
    setJobError(null);
    fetchJob(selectedId)
      .then((j) => {
        if (cancelled) return;
        setJob(j);
        setJobLoading(false);
        // sync the crumb label on direct URL loads (no state) or renames
        const st = location.state as { breadcrumb?: string } | null;
        if (st?.breadcrumb !== j.name) {
          navigate(location.pathname, { replace: true, state: { breadcrumb: j.name } });
        }
      })
      .catch((e: Error) => { if (!cancelled) { setJobError(e.message); setJobLoading(false); } });
    return () => { cancelled = true; };
  // location/navigate deliberately omitted: the replace-navigate above would
  // otherwise re-run this effect (and re-fetch) on every crumb sync
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, fetchJob, detailTick]);

  // Manual refresh: re-pull the list from the printer and re-fetch the open
  // job. The icon spins for at least one full rotation (1s), and if the fetch
  // runs longer it stops at the next full-rotation boundary so it never snaps
  // mid-turn.
  const [spinning, setSpinning] = useState(false);
  const spinStartRef = useRef(0);
  const handleRefresh = useCallback(() => {
    spinStartRef.current = performance.now();
    setSpinning(true);
    refresh();
    setDetailTick((n) => n + 1);
  }, [refresh]);
  useEffect(() => {
    if (!spinning || refreshing) return;
    const elapsed = performance.now() - spinStartRef.current;
    const remaining = 1000 - (elapsed % 1000);
    const id = setTimeout(() => setSpinning(false), remaining);
    return () => clearTimeout(id);
  }, [spinning, refreshing]);

  const handleSave = useCallback(async (patch: { name?: string; printProfileId?: string | null }) => {
    if (!selectedId) return;
    const updated = await updateJob(selectedId, patch);
    setJob(updated);
    // renames change the crumb label
    navigate(`/jobs/${selectedId}`, { replace: true, state: { breadcrumb: updated.name } });
  }, [selectedId, updateJob, navigate]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await deleteJob(selectedId);
    setJob(null);
    navigate("/jobs");
  }, [selectedId, deleteJob, navigate]);

  // Sortable (name / type / created), paginated. Created defaults to newest
  // first; text columns default ascending on first click.
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "createdAt", dir: -1 });
  const handleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: (s.dir * -1) as SortDir }
        : { key, dir: key === "createdAt" ? -1 : 1 },
    );
    setPage(0);
  };
  const sorted = (list ?? [])
    .filter((j): j is NonNullable<typeof j> => j != null)
    .sort((a, b) => {
      const cmp =
        sort.key === "createdAt"
          ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          : a.name.localeCompare(b.name);
      return cmp * sort.dir;
    });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageJobs = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      <BreadcrumbActions>
        <Button
          variant="neutral"
          size="sm"
          title="Refresh jobs from the printer"
          onClick={handleRefresh}
          disabled={spinning}
        >
          <RefreshCw className={cn("size-3", spinning && "animate-spin")} />
          Refresh
        </Button>
      </BreadcrumbActions>
      <div className="grid grid-cols-[420px_1fr] gap-4 flex-1 min-h-0">
        {/* ── job list — the data-table IS the sidebar; the table's own
            border-2 frame stands in for a card ── */}
        <div className="flex flex-col min-h-0 gap-2">
          {listError && <div className="text-xs text-red-600 dark:text-red-400">{listError}</div>}
          {!list && !listError && <div className="text-xs opacity-50">loading…</div>}
          {list?.length === 0 && <div className="text-xs opacity-50">No jobs on the printer.</div>}

          {sorted.length > 0 && (
            // natural-height table: the frame ends at the last row (the gap to
            // the footer flexes), but the container can still shrink below its
            // content so the Table component's inner wrapper div scrolls when
            // rows exceed the available height
            <div className="flex flex-col min-h-0 border-2 border-border [&>div]:min-h-0">
              <Table className="table-fixed border-0">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <SortHead label="Name" sortKey="name" sort={sort} onSort={handleSort} />
                    <SortHead label="Created" sortKey="createdAt" sort={sort} onSort={handleSort} className="w-[92px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageJobs.map((j) => (
                    <TableRow
                      key={j.id}
                      data-state={j.id === selectedId ? "selected" : undefined}
                      onClick={() => navigate(`/jobs/${j.id}`, { state: { breadcrumb: j.name } })}
                      className="cursor-pointer bg-background text-foreground hover:bg-secondary-background data-[state=selected]:bg-main data-[state=selected]:text-main-foreground"
                    >
                      <TableCell className="px-2 py-1.5 text-xs font-heading truncate" title={j.name}>
                        {j.name}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-[10px] whitespace-nowrap">
                        <div>
                          {new Date(j.createdAt).toLocaleDateString(undefined, {
                            year: "numeric", month: "short", day: "numeric",
                          })}
                        </div>
                        <div className="opacity-50">
                          {new Date(j.createdAt).toLocaleTimeString(undefined, {
                            hour: "2-digit", minute: "2-digit",
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* data-table style footer (see neobrutalism data-table demo) —
              two buttons can't overflow the column no matter the page count */}
          {pageCount > 1 && (
            <div className="mt-auto flex items-center gap-2 shrink-0">
              <div className="text-xs opacity-60 mr-auto">
                Page {safePage + 1} of {pageCount}
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
        </div>

        {/* ── detail panel ── */}
        <Card className="flex flex-col min-h-0">
          {/* when a job is loaded, its editable name row IS the header */}
          {!(job && !jobLoading) && (
            <CardHeader>
              <CardTitle>{selectedId ? "Loading…" : "Select a job"}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="flex-1 min-h-0 overflow-hidden">
            {jobLoading && (
              <div className="flex items-center gap-2 text-xs opacity-60">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </div>
            )}
            {jobError && (
              <div className="text-xs text-red-600 dark:text-red-400">{jobError}</div>
            )}
            {!selectedId && (
              <div className="text-xs opacity-50">Select a job from the list to view its details.</div>
            )}
            {job && !jobLoading && (
              <DetailPanel job={job} onSave={handleSave} onDelete={handleDelete} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
