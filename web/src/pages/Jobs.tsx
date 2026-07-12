import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type JobDetail, useJobs } from "@/hooks/useJobs";
import { usePrintProfiles } from "@/hooks/usePrintProfiles";

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

  // Reset when a different job is loaded.
  const jobId = job.id;
  useEffect(() => {
    setName(job.name);
    setProfileId(job.printProfileId ?? "");
    setError(null);
    setConfirmDelete(false);
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
          className={cn(inputCls, "w-56 text-sm font-heading")}
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

      {/* details grid */}
      <div className="grid gap-3 text-xs overflow-y-auto flex-1">
        {/* profile assignment */}
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest opacity-50">Print Profile</div>
          <div className="flex items-center gap-2">
            <select
              value={profileId}
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
            {selectedProfileName && (
              <span className="opacity-50 text-[10px]">{selectedProfileName}</span>
            )}
          </div>
        </div>

        {/* metadata row */}
        <div className="grid grid-cols-2 gap-3 text-[10px] opacity-60">
          <div>
            <span className="uppercase tracking-widest block mb-0.5">Type</span>
            <span>{JOB_TYPE_LABELS[job.type] ?? job.type}</span>
          </div>
          <div>
            <span className="uppercase tracking-widest block mb-0.5">Created</span>
            <span>{formatDate(job.createdAt)}</span>
          </div>
          {job.nestingState?.availableDepth != null && (
            <div>
              <span className="uppercase tracking-widest block mb-0.5">Available depth</span>
              <span>{job.nestingState.availableDepth} mm</span>
            </div>
          )}
          {job.nestingState?.sinteredVolume != null && (
            <div>
              <span className="uppercase tracking-widest block mb-0.5">Sintered volume</span>
              <span>{job.nestingState.sinteredVolume?.toFixed(1)} cm³</span>
            </div>
          )}
        </div>

        {/* flags */}
        <div className="flex gap-3 text-[10px]">
          {job.dryPrintEnabled && (
            <span className="border-2 border-border px-1.5 py-0.5 rounded-base opacity-70">dry print</span>
          )}
          {job.needsLaser && (
            <span className="border-2 border-border px-1.5 py-0.5 rounded-base opacity-70">laser</span>
          )}
          {job.previewEnabled && (
            <span className="border-2 border-border px-1.5 py-0.5 rounded-base opacity-70">preview</span>
          )}
        </div>

        {/* parts list */}
        {job.objectFiles.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-widest opacity-50">
              Parts ({job.objectFiles.length})
            </div>
            <div className="border-2 border-border rounded-base divide-y-2 divide-border">
              {job.objectFiles.map((f) => (
                <div key={f.id} className="px-3 py-1.5 text-xs font-heading">
                  {f.name}
                  <span className="ml-2 text-[10px] font-base opacity-40 font-mono">
                    {f.hash?.slice(0, 8)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {job.objectFiles.length === 0 && (
          <div className="text-[10px] opacity-40">No mesh files attached.</div>
        )}
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function Jobs() {
  const { list, listError, fetchJob, updateJob, deleteJob } = useJobs();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  // Load job when selection changes.
  useEffect(() => {
    if (!selectedId) { setJob(null); return; }
    let cancelled = false;
    setJobLoading(true);
    setJobError(null);
    fetchJob(selectedId)
      .then((j) => { if (!cancelled) { setJob(j); setJobLoading(false); } })
      .catch((e: Error) => { if (!cancelled) { setJobError(e.message); setJobLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedId, fetchJob]);

  const handleSave = useCallback(async (patch: { name?: string; printProfileId?: string | null }) => {
    if (!selectedId) return;
    const updated = await updateJob(selectedId, patch);
    setJob(updated);
  }, [selectedId, updateJob]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await deleteJob(selectedId);
    setSelectedId(null);
    setJob(null);
  }, [selectedId, deleteJob]);

  // Group list by type, newest first within each group.
  const byType = (list ?? [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .reduce<Record<string, typeof list>>((acc, j) => {
      if (!j) return acc;
      const label = JOB_TYPE_LABELS[j.type] ?? j.type;
      (acc[label] ??= []).push(j);
      return acc;
    }, {});

  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      <div className="grid grid-cols-[240px_1fr] gap-4 flex-1 min-h-0">
        {/* ── job list ── */}
        <Card className="flex flex-col min-h-0">
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 overflow-y-auto flex-1 min-h-0">
            {listError && <div className="text-xs text-red-600 dark:text-red-400">{listError}</div>}
            {!list && !listError && <div className="text-xs opacity-50">loading…</div>}
            {list?.length === 0 && <div className="text-xs opacity-50">No jobs on the printer.</div>}

            {Object.entries(byType).map(([typeLabel, jobs]) => (
              <div key={typeLabel}>
                <div className="text-[10px] uppercase tracking-widest opacity-40 pt-2 pb-1 px-1">
                  {typeLabel}
                </div>
                {jobs?.map((j) => j && (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setSelectedId(j.id)}
                    className={cn(
                      "w-full text-left text-xs px-2 py-1.5 border-2 rounded-base transition-all",
                      j.id === selectedId
                        ? "border-border bg-main text-main-foreground shadow-shadow"
                        : "border-transparent hover:border-border hover:bg-secondary-background",
                    )}
                  >
                    <div className="font-heading truncate">{j.name}</div>
                    <div className="text-[10px] opacity-50 mt-0.5">{formatDate(j.createdAt)}</div>
                  </button>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── detail panel ── */}
        <Card className="flex flex-col min-h-0">
          <CardHeader>
            <CardTitle>
              {job ? job.name : selectedId ? "Loading…" : "Select a job"}
            </CardTitle>
          </CardHeader>
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
