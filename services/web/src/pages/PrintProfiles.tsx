import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type PrintProfile, usePrintProfiles } from "@/hooks/usePrintProfiles";

// ── helpers ──────────────────────────────────────────────────────────────────

// "00:00:05.0000000" → "5" (seconds as string for the input)
function delayToSeconds(s: string | null): string {
  if (!s) return "";
  const parts = s.split(":");
  if (parts.length !== 3) return "";
  const h = parseFloat(parts[0]!);
  const m = parseFloat(parts[1]!);
  const sec = parseFloat(parts[2]!);
  const total = h * 3600 + m * 60 + sec;
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

// ── small field components ────────────────────────────────────────────────────

const inputCls =
  "border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground text-xs w-36 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main";

function FieldRow({ label, unit, children }: { label: string; unit?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(160px,auto)_1fr] items-center gap-3 text-xs">
      <label className="opacity-70">{label}{unit ? <span className="opacity-60"> ({unit})</span> : null}</label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function NumField({
  label, unit, draftKey, draft, onChange, integer = false, min, max, step,
}: {
  label: string; unit?: string; draftKey: string;
  draft: Record<string, unknown>; onChange: (key: string, v: unknown) => void;
  integer?: boolean; min?: number; max?: number; step?: number;
}) {
  const raw = draft[draftKey];
  const [local, setLocal] = useState(raw == null ? "" : String(raw));
  const prevRaw = useRef(raw);
  if (prevRaw.current !== raw) { prevRaw.current = raw; setLocal(raw == null ? "" : String(raw)); }

  const commit = () => {
    const t = local.trim();
    if (t === "") { onChange(draftKey, null); return; }
    const n = integer ? parseInt(t, 10) : parseFloat(t);
    if (!isFinite(n)) return;
    if (min != null && n < min) return;
    if (max != null && n > max) return;
    onChange(draftKey, n);
  };

  return (
    <FieldRow label={label} unit={unit}>
      <input
        type="number" value={local} step={step}
        min={min} max={max}
        className={inputCls}
        placeholder="(default)"
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
      />
    </FieldRow>
  );
}

function DelayField({
  label, draftKey, draft, onChange,
}: {
  label: string; draftKey: string;
  draft: Record<string, unknown>; onChange: (key: string, v: unknown) => void;
}) {
  const raw = draft[draftKey] as string | null | undefined;
  const [local, setLocal] = useState(delayToSeconds(raw ?? null));
  const prevRaw = useRef(raw);
  if (prevRaw.current !== raw) { prevRaw.current = raw; setLocal(delayToSeconds(raw ?? null)); }

  const commit = () => {
    const t = local.trim();
    onChange(draftKey, t === "" ? null : secondsToDelay(t));
  };

  return (
    <FieldRow label={label} unit="s">
      <input
        type="number" value={local} min={0} step={1}
        className={inputCls}
        placeholder="(default)"
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
      />
    </FieldRow>
  );
}

function SelectField({
  label, draftKey, draft, onChange, options,
}: {
  label: string; draftKey: string;
  draft: Record<string, unknown>; onChange: (key: string, v: unknown) => void;
  options: { value: string | null; label: string }[];
}) {
  const raw = (draft[draftKey] as string | null | undefined) ?? null;
  return (
    <FieldRow label={label}>
      <select
        value={raw ?? ""}
        className={cn(inputCls, "w-auto pr-6")}
        onChange={(e) => onChange(draftKey, e.target.value === "" ? null : e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value ?? "__null"} value={o.value ?? ""}>{o.label}</option>
        ))}
      </select>
    </FieldRow>
  );
}

function BoolField({
  label, draftKey, draft, onChange,
}: {
  label: string; draftKey: string;
  draft: Record<string, unknown>; onChange: (key: string, v: unknown) => void;
}) {
  const raw = draft[draftKey] as boolean | null | undefined;
  return (
    <FieldRow label={label}>
      <select
        value={raw == null ? "" : String(raw)}
        className={cn(inputCls, "w-auto pr-6")}
        onChange={(e) => {
          const v = e.target.value;
          onChange(draftKey, v === "" ? null : v === "true");
        }}
      >
        <option value="">(default)</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </FieldRow>
  );
}

// ── collapsible section ───────────────────────────────────────────────────────

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
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

// ── material options (enum strings from the .NET model) ───────────────────────

const MATERIAL_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: "(default)" },
  { value: "NotSet", label: "Not set" },
  { value: "PA11", label: "PA11" },
  { value: "PA12", label: "PA12" },
  { value: "TPU", label: "TPU" },
  { value: "Custom1", label: "Custom 1" },
  { value: "Custom2", label: "Custom 2" },
  { value: "Custom3", label: "Custom 3" },
  { value: "Custom4", label: "Custom 4" },
  { value: "Custom5", label: "Custom 5" },
];

// ── edit form ─────────────────────────────────────────────────────────────────

// Builds the PUT body: only the fields the form exposes, with their current
// draft values. Fields not in this list are not sent, preserving whatever the
// stored profile has for them.
function buildPatch(draft: Record<string, unknown>): Record<string, unknown> {
  const FORM_KEYS = [
    "name", "material", "layerThickness", "recoaterPasses",
    "recoaterPowderSpeedPercent", "recoaterPrintSpeedPercent",
    "heatingTargetPowder", "heatingTargetPrint", "heatingTargetPrintBed",
    "heatingRate", "heatingThreshold", "surfaceTarget",
    "beginLayerTemperatureTarget", "beginLayerTemperatureDelay",
    "bedPreparationTemperatureTarget", "bedPreparationTemperatureDelay",
    "bedPreparationThickness",
    "printCapTemperatureTarget", "printCapTemperatureDelay", "printCapThickness",
    "laserOnPercent", "totalEnergyDensityPercent",
    "laserFirstOutlineEnergyDensity", "laserOtherOutlineEnergyDensity",
    "laserFillEnergyDensity", "outlineCount", "isFillEnabled",
    "coolingTarget", "coolingThreshold1", "coolingThreshold2",
    "coolingRate1", "coolingRate2",
  ];
  return Object.fromEntries(FORM_KEYS.map((k) => [k, draft[k] ?? null]));
}

function EditForm({
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
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...profile });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset draft when a different profile is loaded.
  const profileId = profile.id;
  useEffect(() => { setDraft({ ...profile }); setError(null); setConfirmDelete(false); }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = useCallback((key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(buildPatch(draft));
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

  const nameVal = (draft["name"] as string | null) ?? "";

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={nameVal}
          placeholder="Profile name"
          className={cn(inputCls, "w-56 text-sm font-heading")}
          onChange={(e) => onChange("name", e.target.value || null)}
        />
        <Button size="sm" onClick={() => void save()} disabled={saving || deleting}>
          {saving ? <Loader2 className="size-3 animate-spin" /> : null}
          Save
        </Button>
        {!isDefault && (
          confirmDelete ? (
            <>
              <span className="text-xs opacity-70">Delete this profile?</span>
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
          )
        )}
        {isDefault && <span className="text-[10px] opacity-40">system default — cannot be deleted</span>}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>

      {/* form sections */}
      <div className="flex flex-col gap-3 overflow-y-auto flex-1 pr-1">
        <Section title="General">
          <SelectField label="Material" draftKey="material" draft={draft} onChange={onChange} options={MATERIAL_OPTIONS} />
          <NumField label="Layer thickness" unit="mm" draftKey="layerThickness" draft={draft} onChange={onChange} min={0.05} max={1} step={0.01} />
          <NumField label="Recoater passes" draftKey="recoaterPasses" draft={draft} onChange={onChange} integer min={1} max={10} step={1} />
          <NumField label="Powder zone speed" unit="%" draftKey="recoaterPowderSpeedPercent" draft={draft} onChange={onChange} min={1} max={200} step={1} />
          <NumField label="Print bed speed" unit="%" draftKey="recoaterPrintSpeedPercent" draft={draft} onChange={onChange} min={1} max={200} step={1} />
        </Section>

        <Section title="Heating">
          <NumField label="Target: powder" unit="°C" draftKey="heatingTargetPowder" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Target: print" unit="°C" draftKey="heatingTargetPrint" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Target: print bed" unit="°C" draftKey="heatingTargetPrintBed" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Heating rate" draftKey="heatingRate" draft={draft} onChange={onChange} min={0} max={100} step={0.1} />
          <NumField label="Heating threshold" unit="°C" draftKey="heatingThreshold" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Surface target" unit="°C" draftKey="surfaceTarget" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
        </Section>

        <Section title="Layer Temperatures">
          <NumField label="Begin layer target" unit="°C" draftKey="beginLayerTemperatureTarget" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <DelayField label="Begin layer delay" draftKey="beginLayerTemperatureDelay" draft={draft} onChange={onChange} />
          <NumField label="Bed prep target" unit="°C" draftKey="bedPreparationTemperatureTarget" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <DelayField label="Bed prep delay" draftKey="bedPreparationTemperatureDelay" draft={draft} onChange={onChange} />
          <NumField label="Bed prep thickness" unit="mm" draftKey="bedPreparationThickness" draft={draft} onChange={onChange} min={0} max={100} step={1} />
          <NumField label="Print cap target" unit="°C" draftKey="printCapTemperatureTarget" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <DelayField label="Print cap delay" draftKey="printCapTemperatureDelay" draft={draft} onChange={onChange} />
          <NumField label="Print cap thickness" unit="mm" draftKey="printCapThickness" draft={draft} onChange={onChange} min={0} max={100} step={1} />
        </Section>

        <Section title="Laser">
          <NumField label="Laser on" unit="%" draftKey="laserOnPercent" draft={draft} onChange={onChange} min={0} max={100} step={0.5} />
          <NumField label="Total energy" unit="%" draftKey="totalEnergyDensityPercent" draft={draft} onChange={onChange} min={1} max={500} step={1} />
          <NumField label="First outline energy" draftKey="laserFirstOutlineEnergyDensity" draft={draft} onChange={onChange} min={0} max={100} step={0.5} />
          <NumField label="Other outline energy" draftKey="laserOtherOutlineEnergyDensity" draft={draft} onChange={onChange} min={0} max={100} step={0.5} />
          <NumField label="Fill energy" draftKey="laserFillEnergyDensity" draft={draft} onChange={onChange} min={0} max={100} step={0.5} />
          <NumField label="Outline count" draftKey="outlineCount" draft={draft} onChange={onChange} integer min={0} max={20} step={1} />
          <BoolField label="Fill enabled" draftKey="isFillEnabled" draft={draft} onChange={onChange} />
        </Section>

        <Section title="Cooling" defaultOpen={false}>
          <NumField label="Cooling target" unit="°C" draftKey="coolingTarget" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Threshold 1" unit="°C" draftKey="coolingThreshold1" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Threshold 2" unit="°C" draftKey="coolingThreshold2" draft={draft} onChange={onChange} min={0} max={300} step={0.5} />
          <NumField label="Rate 1" draftKey="coolingRate1" draft={draft} onChange={onChange} min={0} max={100} step={0.1} />
          <NumField label="Rate 2" draftKey="coolingRate2" draft={draft} onChange={onChange} min={0} max={100} step={0.1} />
        </Section>
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function PrintProfiles() {
  const { list, listError, fetchProfile, createProfile, updateProfile, deleteProfile } =
    usePrintProfiles();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<PrintProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating_busy, setCreatingBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load profile when selection changes.
  useEffect(() => {
    if (!selectedId) { setProfile(null); return; }
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    fetchProfile(selectedId)
      .then((p) => { if (!cancelled) { setProfile(p); setProfileLoading(false); } })
      .catch((e: Error) => { if (!cancelled) { setProfileError(e.message); setProfileLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedId, fetchProfile]);

  // Auto-select the default profile on first list load.
  const listLoadedRef = useRef(false);
  useEffect(() => {
    if (list && !listLoadedRef.current) {
      listLoadedRef.current = true;
      const def = list.find((p) => p.isDefault);
      if (def) setSelectedId(def.id);
    }
  }, [list]);

  const handleSave = useCallback(async (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    const updated = await updateProfile(selectedId, patch);
    setProfile(updated);
  }, [selectedId, updateProfile]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await deleteProfile(selectedId);
    setSelectedId(null);
    setProfile(null);
  }, [selectedId, deleteProfile]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreatingBusy(true);
    setCreateError(null);
    try {
      const p = await createProfile(name);
      setNewName("");
      setCreating(false);
      setSelectedId(p.id);
    } catch (e) {
      setCreateError((e as Error).message ?? String(e));
    } finally {
      setCreatingBusy(false);
    }
  };

  const isDefault = !!list?.find((p) => p.id === selectedId)?.isDefault;

  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      <div className="grid grid-cols-[220px_1fr] gap-4 flex-1 min-h-0">
        {/* ── profile list ── */}
        <Card className="flex flex-col min-h-0">
          {/* no "Profiles" title (breadcrumb covers it) — the header row
              keeps only the new-profile action */}
          <CardHeader>
            <CardTitle className="flex items-center justify-end">
              <Button
                size="icon"
                variant="neutral"
                title="New profile"
                onClick={() => { setCreating((v) => !v); setNewName(""); setCreateError(null); }}
              >
                <Plus className="size-3" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 overflow-y-auto flex-1 min-h-0">
            {creating && (
              <div className="flex flex-col gap-1 pb-2 border-b-2 border-border mb-1">
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
                  <Button size="sm" onClick={() => void handleCreate()} disabled={creating_busy || !newName.trim()}>
                    {creating_busy ? <Loader2 className="size-3 animate-spin" /> : null}
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

            {list?.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  "text-left text-xs px-2 py-1.5 border-2 rounded-base transition-all",
                  p.id === selectedId
                    ? "border-border bg-main text-main-foreground shadow-shadow translate-x-0 translate-y-0"
                    : "border-transparent hover:border-border hover:bg-secondary-background",
                )}
              >
                <span className="font-heading">{p.name}</span>
                {p.isDefault && (
                  <span className="ml-1 text-[10px] opacity-60">default</span>
                )}
              </button>
            ))}
          </CardContent>
        </Card>

        {/* ── edit panel ── */}
        <Card className="flex flex-col min-h-0">
          <CardHeader>
            <CardTitle>
              {profile
                ? (profile.name ?? "Untitled")
                : selectedId
                  ? "Loading…"
                  : "Select a profile"}
            </CardTitle>
          </CardHeader>
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
                Choose a profile from the list or create a new one.
              </div>
            )}
            {profile && !profileLoading && (
              <EditForm
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
