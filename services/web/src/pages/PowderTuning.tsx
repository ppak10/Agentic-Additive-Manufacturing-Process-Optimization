import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type PrintSetupSnapshot, usePowderTuning } from "@/hooks/usePowderTuning";
import { useStream } from "@/hooks/useStream";

// ── helpers ───────────────────────────────────────────────────────────────────

const inputCls =
  "border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground text-xs w-24 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main";

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

// ── camera feed ───────────────────────────────────────────────────────────────

function CameraFeed() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500); // 2 fps — enough for monitoring
    return () => clearInterval(id);
  }, []);
  return (
    <img
      src={`/api/camera/chamber.jpg?c=${tick}`}
      alt="Chamber"
      className="block w-full border-2 border-border bg-background object-contain"
    />
  );
}

// ── patch grid ────────────────────────────────────────────────────────────────

function PatchGrid({
  gridDim,
  selectedPatch,
  patchResults,
  busy,
  onSelect,
}: {
  gridDim: number;
  selectedPatch: number | null;
  patchResults: { gridIndex: number; usedSetup: PrintSetupSnapshot }[];
  busy: boolean;
  onSelect: (idx: number) => void;
}) {
  const done = new Set(patchResults.map((r) => r.gridIndex));
  const total = gridDim * gridDim;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-widest opacity-50">
        Patch Grid ({gridDim}×{gridDim}) — {done.size}/{total} sintered
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${gridDim}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => {
          const isDone = done.has(i);
          const isSelected = selectedPatch === i;
          const result = patchResults.find((r) => r.gridIndex === i);
          return (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => onSelect(i)}
              title={
                result
                  ? `Patch ${i}: laser ${result.usedSetup.laserOnPercent?.toFixed(0)}% · energy ${result.usedSetup.totalEnergyDensityPercent?.toFixed(0)}%`
                  : `Patch ${i}`
              }
              className={cn(
                "border-2 rounded-base aspect-square flex flex-col items-center justify-center text-[9px] transition-all leading-tight",
                "hover:translate-x-boxShadowX hover:translate-y-boxShadowY shadow-shadow hover:shadow-none",
                isSelected
                  ? "border-border bg-main text-main-foreground shadow-shadow translate-x-0 translate-y-0 hover:translate-x-0 hover:translate-y-0"
                  : isDone
                    ? "border-border bg-secondary-background opacity-80"
                    : "border-border/40 bg-background opacity-50 hover:opacity-100",
              )}
            >
              <span className="font-heading">{i}</span>
              {isDone && <span className="opacity-60 text-[7px]">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── section divider ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-widest opacity-40 pt-2 pb-1">
      {children}
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function PowderTuning() {
  const tuning = usePowderTuning();
  const { snapshot } = useStream();

  const gridDim = tuning.status?.gridDim ?? 5;
  const isActive = tuning.status?.isActive ?? false;

  // Prepare section state
  const [bedStepThickness, setBedStepThickness] = useState<number | null>(null);
  const [bedStepCount, setBedStepCount] = useState<number | null>(null);
  const [bedDryPrint, setBedDryPrint] = useState(false);
  const [layerTempTarget, setLayerTempTarget] = useState<number | null>(null);
  const [layerTempDelay, setLayerTempDelay] = useState<number | null>(null);
  const [surfaceTemp, setSurfaceTemp] = useState<number | null>(null);

  // Print section state (seeded from fetchPrintSetup on session active)
  const [printSetupDefaults, setPrintSetupDefaults] = useState<PrintSetupSnapshot | null>(null);
  const [laserOn, setLaserOn] = useState<number | null>(null);
  const [totalEnergy, setTotalEnergy] = useState<number | null>(null);
  const [fillEnergy, setFillEnergy] = useState<number | null>(null);
  const [fillSpeed, setFillSpeed] = useState<number | null>(null);
  const [outlineSpeed, setOutlineSpeed] = useState<number | null>(null);
  const [outlineCount, setOutlineCount] = useState<number | null>(null);
  const [printNumber, setPrintNumber] = useState(true);

  // Fetch defaults when session becomes active
  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      tuning.fetchPrintSetup()
        .then((s) => {
          setPrintSetupDefaults(s);
          // Pre-fill inputs from session defaults
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

  // Temperature display from live stream
  const temps = snapshot?.data.temperature.entries ?? [];
  const printTemp = temps.find((e) => e.id.toLowerCase().includes("print") || e.id.toLowerCase().includes("surface"));
  const powderTemp = temps.find((e) => e.id.toLowerCase().includes("powder"));

  const handlePrint = async () => {
    const params = {
      laserOnPercent: laserOn ?? undefined,
      totalEnergyDensityPercent: totalEnergy ?? undefined,
      laserFillEnergyDensity: fillEnergy ?? undefined,
      laserFillSpeedXY: fillSpeed ?? undefined,
      laserOutlineSpeedXY: outlineSpeed ?? undefined,
      outlineCount: outlineCount ?? undefined,
      printNumberEnabled: printNumber,
    };
    await tuning.print(params).catch(() => {});
  };

  const ph = (val: number | null | undefined, unit = "") =>
    val != null ? `${val}${unit}` : "—";

  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      {/* ── header status ── */}
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="font-heading text-sm">Powder Tuning</span>
        <span
          className={cn(
            "border-2 border-border px-2 py-0.5 rounded-base text-[10px] font-heading",
            isActive ? "bg-main text-main-foreground" : "opacity-50",
          )}
        >
          {isActive ? tuning.status?.phase ?? "Active" : "No Active Session"}
        </span>
        {printTemp && (
          <span className="opacity-60">
            print {printTemp.currentTemperature.toFixed(1)} °C
            {printTemp.targetTemperature != null && ` → ${printTemp.targetTemperature.toFixed(0)} °C`}
          </span>
        )}
        {powderTemp && (
          <span className="opacity-60">
            powder {powderTemp.currentTemperature.toFixed(1)} °C
          </span>
        )}
        {tuning.busy && <Loader2 className="size-3 animate-spin opacity-60" />}
        {tuning.commandError && (
          <span className="text-red-600 dark:text-red-400">{tuning.commandError}</span>
        )}
      </div>

      {!isActive && (
        <div className="text-xs opacity-50 max-w-sm">
          Start a powder tuning session from the firmware wizard at{" "}
          <code>/wizard/powder-tuning</code> on the printer, then return here to
          control it programmatically.
        </div>
      )}

      {/* ── main split layout ── */}
      <div className="grid grid-cols-[minmax(220px,280px)_1fr] gap-4 flex-1 min-h-0">
        {/* ── left: grid + camera ── */}
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto">
          <Card>
            <CardHeader><CardTitle>Patches</CardTitle></CardHeader>
            <CardContent>
              <PatchGrid
                gridDim={gridDim}
                selectedPatch={tuning.selectedPatch}
                patchResults={tuning.patchResults}
                busy={tuning.busy}
                onSelect={(idx) => { if (isActive) void tuning.selectPatch(idx).catch(() => {}); }}
              />
              {!isActive && (
                <p className="text-[10px] opacity-40 mt-2">
                  Patches become selectable when a session is active.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Chamber</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="px-4 pb-4">
                <CameraFeed />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── right: controls ── */}
        <Card className="flex flex-col min-h-0">
          <CardHeader><CardTitle>Controls</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 overflow-y-auto flex-1 text-xs">

            {/* ── prepare ── */}
            <SectionLabel>1 — Prepare</SectionLabel>

            <div className="grid gap-2 pl-1">
              {/* bed level */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="opacity-70 w-28 shrink-0">Bed level</span>
                <NumInput
                  value={bedStepThickness ?? ""}
                  onChange={setBedStepThickness}
                  placeholder="step mm"
                  min={0} max={10} step={0.1}
                  disabled={!isActive || tuning.busy}
                />
                <NumInput
                  value={bedStepCount ?? ""}
                  onChange={setBedStepCount}
                  placeholder="steps"
                  min={1} max={20} step={1}
                  disabled={!isActive || tuning.busy}
                />
                <label className="flex items-center gap-1 opacity-70">
                  <input
                    type="checkbox"
                    checked={bedDryPrint}
                    disabled={!isActive || tuning.busy}
                    onChange={(e) => setBedDryPrint(e.target.checked)}
                  />
                  dry
                </label>
                <Button
                  size="sm" variant="neutral"
                  disabled={!isActive || tuning.busy}
                  onClick={() => void tuning.bedLevel({
                    stepThickness: bedStepThickness ?? undefined,
                    stepCount: bedStepCount ?? undefined,
                    dryPrint: bedDryPrint,
                  }).catch(() => {})}
                >
                  Level
                </Button>
              </div>

              {/* add layer */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="opacity-70 w-28 shrink-0">Add layer</span>
                <NumInput
                  value={layerTempTarget ?? ""}
                  onChange={setLayerTempTarget}
                  placeholder="target °C"
                  min={0} max={300} step={0.5}
                  disabled={!isActive || tuning.busy}
                />
                <NumInput
                  value={layerTempDelay ?? ""}
                  onChange={setLayerTempDelay}
                  placeholder="delay s"
                  min={0} max={600} step={1}
                  disabled={!isActive || tuning.busy}
                />
                <Button
                  size="sm" variant="neutral"
                  disabled={!isActive || tuning.busy}
                  onClick={() => void tuning.addLayer({
                    temperatureTarget: layerTempTarget ?? undefined,
                    temperatureDelaySeconds: layerTempDelay ?? undefined,
                  }).catch(() => {})}
                >
                  Add
                </Button>
              </div>

              {/* surface temperature */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="opacity-70 w-28 shrink-0">Surface temp</span>
                <NumInput
                  value={surfaceTemp ?? ""}
                  onChange={setSurfaceTemp}
                  placeholder="°C"
                  min={0} max={300} step={0.5}
                  disabled={!isActive || tuning.busy}
                />
                <Button
                  size="sm" variant="neutral"
                  disabled={!isActive || tuning.busy || surfaceTemp == null}
                  onClick={() => void tuning.setSurface(surfaceTemp!).catch(() => {})}
                >
                  Set
                </Button>
              </div>
            </div>

            {/* ── print patch ── */}
            <SectionLabel>2 — Print Patch</SectionLabel>

            <div className="grid gap-2 pl-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="opacity-50 text-[10px]">
                  {tuning.selectedPatch != null
                    ? `Patch #${tuning.selectedPatch} selected — click grid to change`
                    : "Click a patch in the grid to select it"}
                </span>
              </div>

              {/* laser params */}
              {(
                [
                  ["Laser on", laserOn, setLaserOn, 0, 100, 0.5, "%", printSetupDefaults?.laserOnPercent],
                  ["Total energy", totalEnergy, setTotalEnergy, 1, 500, 1, "%", printSetupDefaults?.totalEnergyDensityPercent],
                  ["Fill energy", fillEnergy, setFillEnergy, 0, 100, 0.5, "", printSetupDefaults?.laserFillEnergyDensity],
                  ["Fill speed", fillSpeed, setFillSpeed, 1, 2000, 10, "mm/s", printSetupDefaults?.laserFillSpeedXY],
                  ["Outline speed", outlineSpeed, setOutlineSpeed, 1, 2000, 10, "mm/s", printSetupDefaults?.laserOutlineSpeedXY],
                  ["Outlines", outlineCount, setOutlineCount, 0, 20, 1, "", printSetupDefaults?.outlineCount],
                ] as [string, number | null, (v: number | null) => void, number, number, number, string, number | undefined][]
              ).map(([label, val, setVal, min, max, step, unit, def]) => (
                <div key={label} className="grid grid-cols-[112px_1fr] items-center gap-2">
                  <span className="opacity-70">
                    {label}{unit ? ` (${unit})` : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <NumInput
                      value={val ?? ""}
                      onChange={setVal}
                      placeholder={def != null ? ph(def) : "—"}
                      min={min} max={max} step={step}
                      disabled={!isActive || tuning.busy}
                    />
                    {def != null && val == null && (
                      <span className="text-[10px] opacity-40">profile: {ph(def)}</span>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 opacity-70 text-xs">
                  <input
                    type="checkbox"
                    checked={printNumber}
                    disabled={!isActive || tuning.busy}
                    onChange={(e) => setPrintNumber(e.target.checked)}
                  />
                  Print patch label
                </label>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  disabled={!isActive || tuning.busy || tuning.selectedPatch == null}
                  onClick={() => void handlePrint()}
                >
                  {tuning.busy ? <Loader2 className="size-3 animate-spin" /> : null}
                  Print Patch
                </Button>
                {tuning.selectedPatch != null && tuning.patchResults.find((r) => r.gridIndex === tuning.selectedPatch) && (
                  <span className="text-[10px] opacity-50">patch #{tuning.selectedPatch} already sintered — will re-run</span>
                )}
              </div>
            </div>

            {/* ── completed patches summary ── */}
            {tuning.patchResults.length > 0 && (
              <>
                <SectionLabel>Completed Patches ({tuning.patchResults.length})</SectionLabel>
                <div className="border-2 border-border rounded-base divide-y-2 divide-border overflow-y-auto max-h-40">
                  {tuning.patchResults
                    .slice()
                    .sort((a, b) => a.gridIndex - b.gridIndex)
                    .map((r) => (
                      <div key={r.gridIndex} className="px-3 py-1.5 text-[10px] font-mono flex gap-3 flex-wrap opacity-80">
                        <span className="font-heading text-xs">#{r.gridIndex}</span>
                        <span>laser {r.usedSetup.laserOnPercent?.toFixed(0)}%</span>
                        <span>energy {r.usedSetup.totalEnergyDensityPercent?.toFixed(0)}%</span>
                        <span>fill {r.usedSetup.laserFillEnergyDensity?.toFixed(1)}</span>
                        <span>speed {r.usedSetup.laserFillSpeedXY?.toFixed(0)} mm/s</span>
                      </div>
                    ))}
                </div>
              </>
            )}

            {/* ── stop ── */}
            <SectionLabel>3 — End Session</SectionLabel>
            <div className="pl-1 flex items-center gap-3">
              <Button
                variant="neutral"
                size="sm"
                disabled={!isActive || tuning.busy}
                onClick={() => void tuning.stop().catch(() => {})}
              >
                End Session
              </Button>
              <span className="text-[10px] opacity-40">cap and cool</span>
            </div>

          </CardContent>
        </Card>
      </div>
    </div>
  );
}
