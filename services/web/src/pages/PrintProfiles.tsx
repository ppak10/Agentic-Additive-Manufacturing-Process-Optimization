import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import {
  ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight,
  Loader2, Plus, RefreshCw, Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { type PrintProfile, usePrintProfiles } from "@/hooks/usePrintProfiles";

// Print Profiles — same architecture as the Jobs page: selection is
// route-backed via /profiles/:id? (crumb label rides location.state),
// sortable/paginated data-table on the left, detail card on the right.
// The detail card is a react-hook-form (neobrutalism Form registry
// component) over every surfaced profile field; null = inherit from the
// system Default profile.

// ── helpers ───────────────────────────────────────────────────────────────────

// "00:00:05.0000000" → "5" (seconds as string for the input)
function delayToSeconds(s: string | null): string {
  if (!s) return "";
  const parts = s.split(":");
  if (parts.length !== 3) return "";
  const total = parseFloat(parts[0]!) * 3600 + parseFloat(parts[1]!) * 60 + parseFloat(parts[2]!);
  return isFinite(total) ? String(total) : "";
}

// "5" → "00:00:05" (TimeSpan string the API accepts)
function secondsToDelay(s: string): string | null {
  const n = parseFloat(s);
  if (!isFinite(n) || n < 0) return null;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = Math.round(n % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── breadcrumb-row actions portal (same as Jobs) ──────────────────────────────

function BreadcrumbActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("breadcrumb-actions"));
  }, []);
  return target ? createPortal(children, target) : null;
}

// ── sortable column header (Jobs pattern) ─────────────────────────────────────

type SortKey = "name" | "date";
type SortDir = 1 | -1;

function SortHead({
  label, sortKey, sort, onSort, className,
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

const inputCls =
  "border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground text-xs disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main";

// ── field spec: every surfaced profile field, data-driven ─────────────────────

type FieldKind = "num" | "delay" | "bool" | "material";

interface FieldSpec {
  key: string;
  label: string;
  unit?: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
}

const MATERIALS = ["NotSet", "PA11", "PA12", "TPU", "Custom1", "Custom2", "Custom3", "Custom4", "Custom5"];

const SECTIONS: { title: string; defaultOpen?: boolean; fields: FieldSpec[] }[] = [
  {
    title: "General",
    fields: [
      { key: "material", label: "Material", kind: "material" },
      // thickness fields are MICROMETERS in the firmware (layer 100,
      // bed prep 13000) — the old mm labels/ranges could never edit them
      { key: "layerThickness", label: "Layer thickness", unit: "µm", kind: "num", min: 50, max: 300, step: 10 },
      { key: "recoaterPasses", label: "Recoater passes", kind: "num", min: 1, max: 10, step: 1 },
      { key: "recoaterPowderSpeedPercent", label: "Powder zone speed", unit: "%", kind: "num", min: 1, max: 200, step: 1 },
      { key: "recoaterPrintSpeedPercent", label: "Print bed speed", unit: "%", kind: "num", min: 1, max: 200, step: 1 },
    ],
  },
  {
    title: "Heating",
    fields: [
      { key: "heatingTargetPowder", label: "Target: powder", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "heatingTargetPrint", label: "Target: print", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "heatingTargetPrintBed", label: "Target: print bed", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "heatingRate", label: "Heating rate", kind: "num", min: 0, max: 100, step: 0.1 },
      { key: "heatingThreshold", label: "Heating threshold", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "surfaceTarget", label: "Surface target", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
    ],
  },
  {
    title: "Layer Temperatures",
    fields: [
      { key: "beginLayerTemperatureTarget", label: "Begin layer target", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "beginLayerTemperatureDelay", label: "Begin layer delay", unit: "s", kind: "delay" },
      { key: "bedPreparationTemperatureTarget", label: "Bed prep target", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "bedPreparationTemperatureDelay", label: "Bed prep delay", unit: "s", kind: "delay" },
      { key: "bedPreparationThickness", label: "Bed prep thickness", unit: "µm", kind: "num", min: 0, max: 50000, step: 500 },
      { key: "printCapTemperatureTarget", label: "Print cap target", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "printCapTemperatureDelay", label: "Print cap delay", unit: "s", kind: "delay" },
      { key: "printCapThickness", label: "Print cap thickness", unit: "µm", kind: "num", min: 0, max: 50000, step: 500 },
    ],
  },
  {
    title: "Laser",
    fields: [
      { key: "laserOnPercent", label: "Laser on", unit: "%", kind: "num", min: 0, max: 100, step: 0.5 },
      { key: "totalEnergyDensityPercent", label: "Total energy", unit: "%", kind: "num", min: 1, max: 500, step: 1 },
      { key: "laserFirstOutlineEnergyDensity", label: "First outline energy", kind: "num", min: 0, max: 100, step: 0.5 },
      { key: "laserOtherOutlineEnergyDensity", label: "Other outline energy", kind: "num", min: 0, max: 100, step: 0.5 },
      { key: "laserFillEnergyDensity", label: "Fill energy", kind: "num", min: 0, max: 100, step: 0.5 },
      { key: "outlineCount", label: "Outline count", kind: "num", min: 0, max: 20, step: 1 },
      { key: "isFillEnabled", label: "Fill enabled", kind: "bool" },
    ],
  },
  {
    title: "Cooling",
    defaultOpen: false,
    fields: [
      { key: "coolingTarget", label: "Cooling target", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "coolingThreshold1", label: "Threshold 1", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "coolingThreshold2", label: "Threshold 2", unit: "°C", kind: "num", min: 0, max: 200, step: 0.5 },
      { key: "coolingRate1", label: "Rate 1", kind: "num", min: 0, max: 100, step: 0.1 },
      { key: "coolingRate2", label: "Rate 2", kind: "num", min: 0, max: 100, step: 0.1 },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

// Form state is all strings ("" = inherit Default); converted on submit.
type FormValues = Record<string, string>;

function toForm(p: PrintProfile): FormValues {
  const v: FormValues = { name: p.name ?? "" };
  for (const f of ALL_FIELDS) {
    const raw = p[f.key];
    if (f.kind === "delay") v[f.key] = delayToSeconds((raw as string | null) ?? null);
    else if (f.kind === "bool") v[f.key] = raw == null ? "" : String(raw);
    else v[f.key] = raw == null ? "" : String(raw);
  }
  return v;
}

// PUT body: every surfaced field with its current value ("" → null =
// revert to inheriting the Default); unsurfaced fields aren't sent, so the
// server leaves them as stored.
function toPatch(v: FormValues): Record<string, unknown> {
  const patch: Record<string, unknown> = { name: v.name.trim() || null };
  for (const f of ALL_FIELDS) {
    const s = (v[f.key] ?? "").trim();
    if (s === "") patch[f.key] = null;
    else if (f.kind === "delay") patch[f.key] = secondsToDelay(s);
    else if (f.kind === "bool") patch[f.key] = s === "true";
    else if (f.kind === "material") patch[f.key] = s;
    else patch[f.key] = Number(s);
  }
  return patch;
}

// ── collapsible section ───────────────────────────────────────────────────────

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100 w-full text-left py-1"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {title}
      </button>
      {open && <div className="grid gap-2 pt-1 pl-1">{children}</div>}
    </div>
  );
}

// ── detail / edit form ────────────────────────────────────────────────────────

function ProfileForm({
  profile,
  isDefault,
  onSave,
  onDelete,
}: {
  profile: PrintProfile;
  isDefault: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const form = useForm<FormValues>({ defaultValues: toForm(profile) });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when a different profile is loaded (or a save returns fresh data).
  useEffect(() => {
    form.reset(toForm(profile));
    setError(null);
    setConfirmDelete(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const submit = form.handleSubmit(async (values) => {
    if (!values.name.trim()) { setError("Name cannot be empty"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(toPatch(values));
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSaving(false);
    }
  });

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

  const fieldRow = (f: FieldSpec) => (
    <FormField
      key={f.key}
      control={form.control}
      name={f.key}
      render={({ field }) => (
        <FormItem className="grid grid-cols-[minmax(160px,auto)_1fr] items-center gap-3 space-y-0">
          <FormLabel className="text-xs font-base opacity-70">
            {f.label}
            {f.unit ? <span className="opacity-60"> ({f.unit})</span> : null}
          </FormLabel>
          <FormControl>
            {f.kind === "material" ? (
              <select {...field} className={cn(inputCls, "w-auto pr-6")}>
                <option value="">(default)</option>
                {MATERIALS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : f.kind === "bool" ? (
              <select {...field} className={cn(inputCls, "w-auto pr-6")}>
                <option value="">(default)</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <Input
                {...field}
                type="number"
                min={f.kind === "delay" ? 0 : f.min}
                max={f.max}
                step={f.kind === "delay" ? 1 : f.step}
                placeholder="(default)"
                className="w-36 h-7 text-xs bg-secondary-background"
              />
            )}
          </FormControl>
          <FormMessage className="col-span-2" />
        </FormItem>
      )}
    />
  );

  return (
    <Form {...form}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 h-full">
        {/* action bar — the editable name row IS the header (Jobs pattern) */}
        <div className="flex items-center gap-2 flex-wrap">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="flex-1 min-w-0 space-y-0">
                <FormControl>
                  <Input
                    {...field}
                    placeholder="Profile name"
                    className="text-sm font-heading bg-secondary-background"
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <Button type="submit" size="sm" disabled={saving || deleting || !form.formState.isDirty}>
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            Save
          </Button>
          {!isDefault && (
            confirmDelete ? (
              <>
                <span className="text-xs opacity-70">Delete this profile?</span>
                <Button type="button" size="sm" variant="neutral" onClick={() => void doDelete()} disabled={deleting}>
                  {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                  Confirm
                </Button>
                <Button type="button" size="sm" variant="neutral" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="neutral" onClick={() => setConfirmDelete(true)} disabled={saving || deleting}>
                <Trash2 className="size-3" />
              </Button>
            )
          )}
          {isDefault && <span className="text-[10px] opacity-40">system default — cannot be deleted</span>}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>

        {/* form sections */}
        <div className="flex flex-col gap-3 overflow-y-auto flex-1 pr-1">
          {SECTIONS.map((s) => (
            <Section key={s.title} title={s.title} defaultOpen={s.defaultOpen ?? true}>
              {s.fields.map(fieldRow)}
            </Section>
          ))}
        </div>
      </form>
    </Form>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function PrintProfiles() {
  const { list, listError, refresh, fetchProfile, createProfile, updateProfile, deleteProfile } =
    usePrintProfiles();

  // Selection lives in the route (/profiles/:id?) — same pattern as Jobs.
  const { id } = useParams();
  const selectedId = id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const [profile, setProfile] = useState<PrintProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [detailTick, setDetailTick] = useState(0);

  useEffect(() => {
    if (!selectedId) { setProfile(null); return; }
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    fetchProfile(selectedId)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setProfileLoading(false);
        const st = location.state as { breadcrumb?: string } | null;
        if (st?.breadcrumb !== (p.name ?? undefined)) {
          navigate(location.pathname, { replace: true, state: { breadcrumb: p.name ?? undefined } });
        }
      })
      .catch((e: Error) => { if (!cancelled) { setProfileError(e.message); setProfileLoading(false); } });
  // location/navigate deliberately omitted (crumb-sync replace would refetch)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, fetchProfile, detailTick]);

  // Manual refresh with the Jobs page's full-rotation spinner.
  const [spinning, setSpinning] = useState(false);
  const spinStartRef = useRef(0);
  const handleRefresh = useCallback(() => {
    spinStartRef.current = performance.now();
    setSpinning(true);
    refresh();
    setDetailTick((n) => n + 1);
  }, [refresh]);
  useEffect(() => {
    if (!spinning) return;
    const elapsed = performance.now() - spinStartRef.current;
    const remaining = 1000 - (elapsed % 1000);
    const t = setTimeout(() => setSpinning(false), remaining);
    return () => clearTimeout(t);
  }, [spinning]);

  const handleSave = useCallback(async (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    const updated = await updateProfile(selectedId, patch);
    setProfile(updated);
    navigate(`/profiles/${selectedId}`, { replace: true, state: { breadcrumb: updated.name ?? undefined } });
  }, [selectedId, updateProfile, navigate]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await deleteProfile(selectedId);
    setProfile(null);
    navigate("/profiles");
  }, [selectedId, deleteProfile, navigate]);

  // Inline create row (opened from the breadcrumb action).
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const p = await createProfile(name);
      setNewName("");
      setCreating(false);
      navigate(`/profiles/${p.id}`, { state: { breadcrumb: p.name ?? undefined } });
    } catch (e) {
      setCreateError((e as Error).message ?? String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  // Sortable (name / date), paginated. The date is the profile file's mtime
  // (modifiedAt) with the stored createdAt as fallback; defaults to newest
  // first, undated profiles sort as oldest.
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: -1 });
  const handleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: (s.dir * -1) as SortDir }
        : { key, dir: key === "date" ? -1 : 1 },
    );
    setPage(0);
  };
  const dateOf = (p: { modifiedAt: string | null; createdAt: string | null }) =>
    p.modifiedAt ?? p.createdAt;
  const sorted = [...(list ?? [])].sort((a, b) => {
    const cmp =
      sort.key === "date"
        ? (dateOf(a) ? new Date(dateOf(a)!).getTime() : 0) -
          (dateOf(b) ? new Date(dateOf(b)!).getTime() : 0)
        : a.name.localeCompare(b.name);
    return cmp * sort.dir;
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const isDefault = !!list?.find((p) => p.id === selectedId)?.isDefault;

  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      <BreadcrumbActions>
        <Button
          variant="neutral"
          size="sm"
          title="New print profile"
          onClick={() => { setCreating((v) => !v); setNewName(""); setCreateError(null); }}
        >
          <Plus className="size-3" />
          New
        </Button>
        <Button
          variant="neutral"
          size="sm"
          title="Refresh profiles from the printer"
          onClick={handleRefresh}
          disabled={spinning}
        >
          <RefreshCw className={cn("size-3", spinning && "animate-spin")} />
          Refresh
        </Button>
      </BreadcrumbActions>

      <div className="grid grid-cols-[300px_1fr] gap-4 flex-1 min-h-0">
        {/* ── profile list — data-table sidebar (Jobs pattern) ── */}
        <div className="flex flex-col min-h-0 gap-2">
          {creating && (
            <div className="flex flex-col gap-1 border-2 border-border rounded-base p-2">
              <input
                autoFocus
                type="text"
                placeholder="Profile name"
                value={newName}
                className={cn(inputCls, "w-full")}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") { setCreating(false); setNewName(""); }
                }}
              />
              <div className="flex gap-1">
                <Button size="sm" onClick={() => void handleCreate()} disabled={createBusy || !newName.trim()}>
                  {createBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                  Create
                </Button>
                <Button size="sm" variant="neutral" onClick={() => { setCreating(false); setNewName(""); }}>
                  Cancel
                </Button>
              </div>
              {createError && <span className="text-[10px] text-red-600 dark:text-red-400">{createError}</span>}
            </div>
          )}

          {listError && <div className="text-xs text-red-600 dark:text-red-400">{listError}</div>}
          {!list && !listError && <div className="text-xs opacity-50">loading…</div>}
          {list?.length === 0 && <div className="text-xs opacity-50">No profiles on the printer.</div>}

          {sorted.length > 0 && (
            <div className="flex flex-col min-h-0 border-2 border-border [&>div]:min-h-0">
              <Table className="table-fixed border-0">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <SortHead label="Name" sortKey="name" sort={sort} onSort={handleSort} />
                    <SortHead label="Modified" sortKey="date" sort={sort} onSort={handleSort} className="w-[92px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((p) => (
                    <TableRow
                      key={p.id}
                      data-state={p.id === selectedId ? "selected" : undefined}
                      onClick={() => navigate(`/profiles/${p.id}`, { state: { breadcrumb: p.name } })}
                      className="cursor-pointer bg-background text-foreground hover:bg-secondary-background data-[state=selected]:bg-main data-[state=selected]:text-main-foreground"
                    >
                      <TableCell className="px-2 py-1.5 text-xs font-heading truncate" title={p.name}>
                        {p.name}
                        {p.isDefault && <span className="ml-1 text-[10px] font-base opacity-60">default</span>}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-[10px] whitespace-nowrap">
                        {dateOf(p) ? (
                          <>
                            <div>
                              {new Date(dateOf(p)!).toLocaleDateString(undefined, {
                                year: "numeric", month: "short", day: "numeric",
                              })}
                            </div>
                            <div className="opacity-50">
                              {new Date(dateOf(p)!).toLocaleTimeString(undefined, {
                                hour: "2-digit", minute: "2-digit",
                              })}
                            </div>
                          </>
                        ) : (
                          <span className="opacity-40">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pageCount > 1 && (
            <div className="mt-auto flex items-center gap-2 shrink-0">
              <div className="text-xs opacity-60 mr-auto">
                Page {safePage + 1} of {pageCount}
              </div>
              <Button variant="noShadow" size="sm" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <Button variant="noShadow" size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>
                Next
              </Button>
            </div>
          )}
        </div>

        {/* ── detail panel ── */}
        <Card className="flex flex-col min-h-0">
          {!(profile && !profileLoading) && (
            <CardHeader>
              <CardTitle>{selectedId ? "Loading…" : "Select a profile"}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="flex-1 min-h-0 overflow-hidden">
            {profileLoading && (
              <div className="flex items-center gap-2 text-xs opacity-60">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </div>
            )}
            {profileError && (
              <div className="text-xs text-red-600 dark:text-red-400">{profileError}</div>
            )}
            {!selectedId && (
              <div className="text-xs opacity-50">
                Select a profile from the list, or create one with New in the
                breadcrumb row. Empty fields inherit from the system Default.
              </div>
            )}
            {profile && !profileLoading && (
              <ProfileForm
                profile={profile}
                isDefault={isDefault}
                onSave={handleSave}
                onDelete={handleDelete}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
