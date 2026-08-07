import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type PrintSetupSnapshot,
  usePowderTuning,
} from "@/hooks/usePowderTuning";
import { useCameraStream } from "@/hooks/useCameraStream";
import { ThermalOverlay } from "@/components/ThermalOverlay";
import { useStream } from "@/hooks/useStream";

// The powder-tuning operating surface — lives in the conversation artifact
// panel (auto-attached while a session is active). Configuration column on
// the left; on the right a mission-control-style feed with three views —
// Live (chamber), Temp (thermal), Plot (galvo) — mirroring the firmware's
// own tuning page toggle, with a READ-ONLY patch grid inset in the top-right
// corner on every view; patch selection happens via the "Patch #" field in
// the print section (or by the agent through MCP).
//
// Patch-grid state merges TWO sources: this browser's own prints (the hook's
// local patchResults) and the agent action log replay from
// /api/powder-tuning/actions — so agent-driven sinters show up here and a
// reload doesn't blank the grid. GUI prints from OTHER browsers are not in
// either source (known gap; the action log only records MCP calls).

interface PatchAction {
  grid_index: number | null;
  ts: string;
  setup: {
    laserOnPercent?: number;
    totalEnergyDensityPercent?: number;
    laserFillEnergyDensity?: number;
    laserFillSpeedXY?: number;
  };
}

interface ActionsState {
  selected: number | null;
  patches: PatchAction[];
}

function useAgentActions(): ActionsState | null {
  const [actions, setActions] = useState<ActionsState | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/powder-tuning/actions");
        const d = (await r.json()) as ActionsState;
        if (!cancelled && r.ok) setActions(d);
      } catch {
        /* api unreachable — keep last state */
      }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  return actions;
}

const inputCls =
  "border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground text-xs w-20 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main";

function NumInput({
  value, onChange, placeholder, min, max, step, disabled,
}: {
  value: number | string;
  onChange: (v: number | null) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(value === "" || value == null ? "" : String(value));
  const prevValue = useRef(value);
  if (prevValue.current !== value) {
    prevValue.current = value;
    setLocal(value === "" || value == null ? "" : String(value));
  }
  const commit = () => {
    const t = local.trim();
    if (t === "") { onChange(null); return; }
    const n = parseFloat(t);
    if (isFinite(n)) onChange(n);
  };
  return (
    <input
      type="number" value={local} min={min} max={max} step={step}
      disabled={disabled}
      placeholder={placeholder ?? "—"}
      className={inputCls}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
    />
  );
}

// Feed views: Live (chamber WebSocket — same feed Mission Control uses) and
// Plot (galvo, 1 fps polling; points-over-WS exists but not an image). Temp
// is NOT a separate view anymore: it's the bed-registered thermal overlay
// (H∘T projected digits, shared with Mission Control) toggled over Live.
const FEED_VIEWS = [
  { key: "live", label: "Live", src: "/api/camera/chamber.jpg", alt: "Chamber", periodMs: 500 },
  { key: "plot", label: "Plot", src: "/api/camera/galvo.png", alt: "Galvo plot", periodMs: 1000 },
] as const;
type FeedKey = (typeof FEED_VIEWS)[number]["key"];

const FEED_IMG_CLS = "block w-full border-2 border-border bg-background object-contain";

// Own component so the WebSocket opens only while the Live view is mounted
// (the hook closes it on unmount). Falls back to the polled JPEG until the
// first frame arrives, so a broker/recorder restart never blanks the view.
// Streamed frames land on the img imperatively — no re-render per frame.
function LiveChamberFeed() {
  const { imgRef, hasFrame } = useCameraStream("/api/camera/chamber/stream");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (hasFrame) return; // streaming — no need to poll
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [hasFrame]);
  return (
    <>
      <img
        ref={imgRef}
        alt="Chamber"
        className={FEED_IMG_CLS}
        style={{ display: hasFrame ? undefined : "none" }}
      />
      {!hasFrame && (
        <img src={`/api/camera/chamber.jpg?c=${tick}`} alt="Chamber" className={FEED_IMG_CLS} />
      )}
    </>
  );
}

function PolledFeed({ view }: { view: Exclude<FeedKey, "live"> }) {
  const spec = FEED_VIEWS.find((v) => v.key === view) ?? FEED_VIEWS[1];
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), spec.periodMs);
    return () => clearInterval(id);
  }, [spec.periodMs]);
  return <img src={`${spec.src}?c=${tick}`} alt={spec.alt} className={FEED_IMG_CLS} />;
}

function CameraFeed({ view }: { view: FeedKey }) {
  return view === "live" ? <LiveChamberFeed /> : <PolledFeed view={view} />;
}

const FEED_BTN_CLS = (active: boolean) =>
  cn(
    "border-2 border-border rounded-base px-2 py-0.5 text-[10px] font-heading backdrop-blur-[1px]",
    active ? "bg-main text-main-foreground" : "bg-background/80 opacity-70 hover:opacity-100",
  );

// Live/Plot switch + the Temp overlay toggle (Mission Control style —
// pressing Temp from Plot jumps back to Live, where the overlay renders).
function FeedToggle({
  view,
  onChange,
  temp,
  onTemp,
}: {
  view: FeedKey;
  onChange: (v: FeedKey) => void;
  temp: boolean;
  onTemp: (on: boolean) => void;
}) {
  return (
    <div className="absolute bottom-1.5 left-1.5 flex gap-1">
      {FEED_VIEWS.map((v) => (
        <button key={v.key} onClick={() => onChange(v.key)} className={FEED_BTN_CLS(view === v.key)}>
          {v.label}
        </button>
      ))}
      <button
        onClick={() => {
          onTemp(view === "live" ? !temp : true);
          onChange("live");
        }}
        title="Bed-registered thermal grid over the chamber view"
        className={FEED_BTN_CLS(temp && view === "live")}
      >
        Temp
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-widest opacity-40 pt-2 pb-1">
      {children}
    </div>
  );
}

// Read-only patch grid, inset over the chamber feed. Display only — shows
// sintered (✓) and selected patches; selection is driven from the Patch #
// field or by the agent.
function PatchGridInset({
  gridDim,
  doneBy,
  selected,
}: {
  gridDim: number;
  doneBy: Map<number, string>;
  selected: number | null;
}) {
  const total = gridDim * gridDim;
  return (
    <div className="absolute top-1.5 right-1.5 border-2 border-border rounded-base bg-background/80 backdrop-blur-[1px] p-1 flex flex-col gap-0.5">
      <div
        className="grid gap-0.5 w-24"
        style={{ gridTemplateColumns: `repeat(${gridDim}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => {
          const done = doneBy.has(i);
          const isSelected = selected === i;
          return (
            <div
              key={i}
              title={doneBy.get(i) ?? `Patch ${i}`}
              className={cn(
                "border rounded-[2px] aspect-square flex items-center justify-center text-[7px] leading-none",
                isSelected
                  ? "border-border bg-main text-main-foreground font-heading"
                  : done
                    ? "border-border bg-secondary-background"
                    : "border-border/40 bg-background/60 opacity-60",
              )}
            >
              {done && !isSelected ? "✓" : i}
            </div>
          );
        })}
      </div>
      <div className="text-[7px] font-mono text-center opacity-60">
        {doneBy.size}/{total}
      </div>
    </div>
  );
}

export function PowderTuningArtifact() {
  const tuning = usePowderTuning();
  const { snapshot } = useStream();
  const agent = useAgentActions();

  const gridDim = tuning.status?.gridDim ?? 5;
  const total = gridDim * gridDim;
  const isActive = tuning.status?.isActive ?? false;

  // done-set: this browser's prints + the agent action-log replay
  const doneBy = new Map<number, string>(); // index → tooltip
  for (const p of agent?.patches ?? []) {
    if (p.grid_index != null) {
      doneBy.set(
        p.grid_index,
        `Patch ${p.grid_index} (agent): laser ${p.setup.laserOnPercent ?? "—"}% · energy ${p.setup.totalEnergyDensityPercent ?? "—"}%`,
      );
    }
  }
  for (const r of tuning.patchResults) {
    doneBy.set(
      r.gridIndex,
      `Patch ${r.gridIndex}: laser ${r.usedSetup.laserOnPercent?.toFixed(0)}% · energy ${r.usedSetup.totalEnergyDensityPercent?.toFixed(0)}%`,
    );
  }
  const selectedPatch = tuning.selectedPatch ?? agent?.selected ?? null;

  // feed view (Live / Plot) + the thermal overlay toggle on Live
  const [feedView, setFeedView] = useState<FeedKey>("live");
  const [showTemp, setShowTemp] = useState(false);

  // prepare-section state
  const [bedStepThickness, setBedStepThickness] = useState<number | null>(null);
  const [bedStepCount, setBedStepCount] = useState<number | null>(null);
  const [bedDryPrint, setBedDryPrint] = useState(false);
  const [layerThickness, setLayerThickness] = useState<number | null>(null);
  const [layerTempTarget, setLayerTempTarget] = useState<number | null>(null);
  const [surfaceTemp, setSurfaceTemp] = useState<number | null>(null);

  // print-section state, seeded from the session's effective setup
  const [printSetupDefaults, setPrintSetupDefaults] = useState<PrintSetupSnapshot | null>(null);
  const [laserOn, setLaserOn] = useState<number | null>(null);
  const [totalEnergy, setTotalEnergy] = useState<number | null>(null);
  const [fillEnergy, setFillEnergy] = useState<number | null>(null);
  const [fillSpeed, setFillSpeed] = useState<number | null>(null);
  const [outlineSpeed, setOutlineSpeed] = useState<number | null>(null);
  const [outlineCount, setOutlineCount] = useState<number | null>(null);
  const [overlap, setOverlap] = useState<number | null>(null);
  const [powerIncrease, setPowerIncrease] = useState<number | null>(null);
  const [fillSkip, setFillSkip] = useState<number | null>(null);
  const [printNumber, setPrintNumber] = useState(true);

  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      tuning.fetchPrintSetup()
        .then((s) => {
          setPrintSetupDefaults(s);
          setLaserOn(s.laserOnPercent ?? null);
          setTotalEnergy(s.totalEnergyDensityPercent ?? null);
          setFillEnergy(s.laserFillEnergyDensity ?? null);
          setFillSpeed(s.laserFillSpeedXY ?? null);
          setOutlineSpeed(s.laserOutlineSpeedXY ?? null);
          setOutlineCount(s.outlineCount ?? null);
        })
        .catch(() => { /* session just started; not critical */ });
    }
    prevActiveRef.current = isActive;
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const temps = snapshot?.data.temperature.entries ?? [];
  const printTemp = temps.find((e) => e.id.toLowerCase().includes("print") || e.id.toLowerCase().includes("surface"));
  const powderTemp = temps.find((e) => e.id.toLowerCase().includes("powder"));

  const handlePrint = async () => {
    await tuning.print({
      laserOnPercent: laserOn ?? undefined,
      totalEnergyDensityPercent: totalEnergy ?? undefined,
      laserFillEnergyDensity: fillEnergy ?? undefined,
      laserFillSpeedXY: fillSpeed ?? undefined,
      laserOutlineSpeedXY: outlineSpeed ?? undefined,
      outlineCount: outlineCount ?? undefined,
      hotspotOverlapPercent: overlap ?? undefined,
      outlinePowerIncrease: powerIncrease ?? undefined,
      fillOutlineSkipCount: fillSkip ?? undefined,
      printNumberEnabled: printNumber,
    }).catch(() => {});
  };

  const ph = (val: number | null | undefined, unit = "") =>
    val != null ? `${val}${unit}` : "—";

  // The wizard runs a two-stage flow: an initial heat-up under
  // mode=AnalyseHeating BEFORE the session flips to PowderTuning and the
  // command tools unlock. Surface that stage instead of "No Active Session"
  // so the operator sees the ramp is in progress.
  const wizardHeating = !isActive && tuning.status?.mode === "AnalyseHeating";

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* ── status ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-heading text-sm">Powder Tuning</span>
        <span
          className={cn(
            "border-2 border-border px-2 py-0.5 rounded-base text-[10px] font-heading",
            isActive
              ? "bg-main text-main-foreground"
              : wizardHeating
                ? "bg-secondary-background"
                : "opacity-50",
          )}
        >
          {isActive
            ? tuning.status?.phase ?? "Active"
            : wizardHeating
              ? `Wizard: ${tuning.status?.phase ?? "Heating"}…`
              : "No Active Session"}
        </span>
        {printTemp && (
          <span className="opacity-60">
            print {printTemp.currentTemperature.toFixed(1)} °C
            {printTemp.targetTemperature != null && ` → ${printTemp.targetTemperature.toFixed(0)} °C`}
          </span>
        )}
        {powderTemp && (
          <span className="opacity-60">powder {powderTemp.currentTemperature.toFixed(1)} °C</span>
        )}
        {(isActive || wizardHeating) && tuning.status?.surfaceTarget != null && (
          <span className="opacity-60">
            surface → {Number(tuning.status.surfaceTarget).toFixed(1)} °C{" "}
            {tuning.status.surfaceTargetReached ? "✓" : "(heating…)"}
          </span>
        )}
        {isActive && tuning.status?.z2 != null && (
          <span className="font-mono text-[10px] opacity-40">
            Z1 {Number(tuning.status.z1 ?? 0).toFixed(2)} · Z2 {Number(tuning.status.z2).toFixed(2)}
          </span>
        )}
        {tuning.busy && <Loader2 className="size-3 animate-spin opacity-60" />}
        {tuning.commandError && (
          <span className="text-red-600 dark:text-red-400">{tuning.commandError}</span>
        )}
      </div>

      {!isActive && (
        <p className="text-[10px] opacity-50">
          {wizardHeating ? (
            <>
              The wizard's initial heat-up is running — the session (and these
              controls) unlock when it completes and the firmware enters
              powder-testing.
            </>
          ) : (
            <>
              Start a session from the firmware wizard at{" "}
              <code>/wizard/powder-tuning</code> on the printer (attach the
              material's print profile there); controls activate here.
            </>
          )}
        </p>
      )}

      {/* ── configuration left · chamber (with grid inset) right ── */}
      <div className="grid grid-cols-[minmax(230px,320px)_1fr] gap-3 items-start">
        {/* left: configuration */}
        <div className="flex flex-col gap-2">
          <SectionLabel>1 — Prepare</SectionLabel>
          <div className="grid gap-2 pl-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="opacity-70 w-20 shrink-0">Bed level</span>
              <NumInput value={bedStepThickness ?? ""} onChange={setBedStepThickness}
                placeholder="step mm" min={0} max={10} step={0.1} disabled={!isActive || tuning.busy} />
              <NumInput value={bedStepCount ?? ""} onChange={setBedStepCount}
                placeholder="steps" min={1} max={20} step={1} disabled={!isActive || tuning.busy} />
              <label className="flex items-center gap-1 opacity-70">
                <input type="checkbox" checked={bedDryPrint} disabled={!isActive || tuning.busy}
                  onChange={(e) => setBedDryPrint(e.target.checked)} />
                dry
              </label>
              <Button size="sm" variant="neutral" disabled={!isActive || tuning.busy}
                onClick={() => void tuning.bedLevel({
                  stepThickness: bedStepThickness ?? undefined,
                  stepCount: bedStepCount ?? undefined,
                  dryPrint: bedDryPrint,
                }).catch(() => {})}>
                Level
              </Button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="opacity-70 w-20 shrink-0">Add layer</span>
              <NumInput value={layerThickness ?? ""} onChange={setLayerThickness}
                placeholder="µm (100)" min={10} max={1000} step={10} disabled={!isActive || tuning.busy} />
              <NumInput value={layerTempTarget ?? ""} onChange={setLayerTempTarget}
                placeholder="target °C" min={0} max={300} step={0.5} disabled={!isActive || tuning.busy} />
              <Button size="sm" variant="neutral" disabled={!isActive || tuning.busy}
                onClick={() => void tuning.addLayer({
                  layerThickness: layerThickness ?? undefined,
                  temperatureTarget: layerTempTarget ?? undefined,
                }).catch(() => {})}>
                Add
              </Button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="opacity-70 w-20 shrink-0">Surface</span>
              <NumInput value={surfaceTemp ?? ""} onChange={setSurfaceTemp}
                placeholder="°C" min={0} max={300} step={0.5} disabled={!isActive || tuning.busy} />
              <Button size="sm" variant="neutral"
                disabled={!isActive || tuning.busy || surfaceTemp == null}
                onClick={() => void tuning.setSurface(surfaceTemp!).catch(() => {})}>
                Set
              </Button>
            </div>
          </div>

          <SectionLabel>2 — Print Patch</SectionLabel>
          <div className="grid gap-2 pl-1">
            <div className="grid grid-cols-[96px_1fr] items-center gap-2">
              <span className="opacity-70">Patch #</span>
              <div className="flex items-center gap-2">
                <NumInput
                  value={selectedPatch ?? ""}
                  onChange={(v) => {
                    if (v != null && v >= 0 && v < total) void tuning.selectPatch(v).catch(() => {});
                  }}
                  placeholder={`0–${total - 1}`}
                  min={0} max={total - 1} step={1}
                  disabled={!isActive || tuning.busy}
                />
                <span className="text-[10px] opacity-40">row-major, 0–{total - 1}</span>
              </div>
            </div>

            {(
              [
                ["Laser on", laserOn, setLaserOn, 0, 100, 0.5, "%", printSetupDefaults?.laserOnPercent],
                ["Total energy", totalEnergy, setTotalEnergy, 1, 500, 1, "%", printSetupDefaults?.totalEnergyDensityPercent],
                ["Fill energy", fillEnergy, setFillEnergy, 0, 100, 0.5, "", printSetupDefaults?.laserFillEnergyDensity],
                ["Fill speed", fillSpeed, setFillSpeed, 1, 2000, 10, "mm/s", printSetupDefaults?.laserFillSpeedXY],
                ["Outline speed", outlineSpeed, setOutlineSpeed, 1, 2000, 10, "mm/s", printSetupDefaults?.laserOutlineSpeedXY],
                ["Outlines", outlineCount, setOutlineCount, 0, 20, 1, "", printSetupDefaults?.outlineCount],
                ["Overlap", overlap, setOverlap, 0, 100, 5, "%", printSetupDefaults?.hotspotOverlapPercent],
                ["Outline pwr+", powerIncrease, setPowerIncrease, 0, 100, 1, "", printSetupDefaults?.outlinePowerIncrease],
                ["Fill skip", fillSkip, setFillSkip, 0, 20, 1, "", printSetupDefaults?.fillOutlineSkipCount],
              ] as [string, number | null, (v: number | null) => void, number, number, number, string, number | undefined][]
            ).map(([label, val, setVal, min, max, step, unit, def]) => (
              <div key={label} className="grid grid-cols-[96px_1fr] items-center gap-2">
                <span className="opacity-70">{label}{unit ? ` (${unit})` : ""}</span>
                <div className="flex items-center gap-2">
                  <NumInput value={val ?? ""} onChange={setVal}
                    placeholder={def != null ? ph(def) : "—"}
                    min={min} max={max} step={step} disabled={!isActive || tuning.busy} />
                  {def != null && val == null && (
                    <span className="text-[10px] opacity-40">profile: {ph(def)}</span>
                  )}
                </div>
              </div>
            ))}

            <label className="flex items-center gap-1 opacity-70">
              <input type="checkbox" checked={printNumber} disabled={!isActive || tuning.busy}
                onChange={(e) => setPrintNumber(e.target.checked)} />
              Print patch label
            </label>

            <div className="flex items-center gap-2 pt-1">
              <Button disabled={!isActive || tuning.busy || selectedPatch == null}
                onClick={() => void handlePrint()}>
                {tuning.busy ? <Loader2 className="size-3 animate-spin" /> : null}
                Print Patch
              </Button>
              {selectedPatch != null && doneBy.has(selectedPatch) && (
                <span className="text-[10px] opacity-50">
                  #{selectedPatch} already sintered — will re-run
                </span>
              )}
            </div>
          </div>

          <SectionLabel>3 — End Session</SectionLabel>
          <div className="pl-1 flex items-center gap-3 pb-2">
            <Button variant="neutral" size="sm" disabled={!isActive || tuning.busy}
              onClick={() => void tuning.stop().catch(() => {})}>
              End Session
            </Button>
            <span className="text-[10px] opacity-40">cap and cool</span>
          </div>
        </div>

        {/* right: Live/Plot feed with the thermal overlay toggle and the
            read-only patch grid inset top-right */}
        <div className="relative min-w-0">
          <CameraFeed view={feedView} />
          {feedView === "live" && showTemp && <ThermalOverlay />}
          <FeedToggle view={feedView} onChange={setFeedView} temp={showTemp} onTemp={setShowTemp} />
          <PatchGridInset gridDim={gridDim} doneBy={doneBy} selected={selectedPatch} />
        </div>
      </div>

      {/* ── sintered patches ── */}
      {(tuning.patchResults.length > 0 || (agent?.patches.length ?? 0) > 0) && (
        <>
          <SectionLabel>Sintered Patches</SectionLabel>
          <div className="border-2 border-border rounded-base divide-y-2 divide-border overflow-y-auto max-h-40">
            {[
              ...tuning.patchResults.map((r) => ({
                key: `gui-${r.gridIndex}`,
                idx: r.gridIndex,
                by: "gui",
                laser: r.usedSetup.laserOnPercent,
                energy: r.usedSetup.totalEnergyDensityPercent,
                fill: r.usedSetup.laserFillEnergyDensity,
                speed: r.usedSetup.laserFillSpeedXY,
              })),
              ...(agent?.patches ?? [])
                .filter((p) => p.grid_index == null || !tuning.patchResults.some((r) => r.gridIndex === p.grid_index))
                .map((p, i) => ({
                  key: `agent-${p.grid_index ?? `u${i}`}`,
                  idx: p.grid_index,
                  by: "agent",
                  laser: p.setup.laserOnPercent,
                  energy: p.setup.totalEnergyDensityPercent,
                  fill: p.setup.laserFillEnergyDensity,
                  speed: p.setup.laserFillSpeedXY,
                })),
            ]
              .sort((a, b) => (a.idx ?? 999) - (b.idx ?? 999))
              .map((r) => (
                <div key={r.key} className="px-3 py-1.5 text-[10px] font-mono flex gap-3 flex-wrap opacity-80">
                  <span className="font-heading text-xs">#{r.idx ?? "?"}</span>
                  <span>laser {r.laser != null ? Number(r.laser).toFixed(0) : "—"}%</span>
                  <span>energy {r.energy != null ? Number(r.energy).toFixed(0) : "—"}%</span>
                  <span>fill {r.fill != null ? Number(r.fill).toFixed(1) : "—"}</span>
                  <span>speed {r.speed != null ? Number(r.speed).toFixed(0) : "—"} mm/s</span>
                  <span className="ml-auto opacity-50">{r.by}</span>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
