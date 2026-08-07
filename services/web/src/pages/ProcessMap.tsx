import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Download } from "lucide-react";
import {
  CartesianGrid,
  Cell,
  ErrorBar,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ChartContainer } from "@/components/ui/chart";
import { exportChart, type ChartExportFormat, type ExportLegend } from "@/lib/chartExport";
import { BATCH_COLORS, CONTROL_COLOR } from "@/pages/AstmTests";

// Process Map — mechanical outcomes across the process-parameter space.
// One point per tested SLS specimen (astm_specimens), parameters taken from
// the specimen's print-time profile snapshot (profiles are upserted in place,
// so only the snapshot preserves what a specimen actually printed with).
// Served by /api/process-map (:3400). Today only LaserFillEnergyDensity
// varies across builds; the axis pickers keep the page general for future
// sweeps.

interface ProcessMapPoint {
  standard: string;
  sample_id: string;
  batch_label: string | null;
  material_class: string | null;
  test_date: string | null;
  job_id: string | null;
  print_date: string | null;
  print_profile_id: string | null;
  modulus_pa: number | null;
  peak_stress_pa: number | null;
  strain_at_peak: number | null;
  stress_at_break_pa: number | null;
  strain_at_break: number | null;
  energy_to_break_j: number | null;
  test_end_reason: string | null;
  profile_name: string | null;
  job_name: string | null;
  params: Record<string, number | null>;
}

interface ProcessMapResp {
  params: string[];
  points: ProcessMapPoint[];
}

const OUTCOMES = [
  { key: "modulus_pa", label: "Modulus", unit: "MPa", scale: 1e-6 },
  { key: "peak_stress_pa", label: "Peak σ", unit: "MPa", scale: 1e-6 },
  { key: "strain_at_break", label: "ε break", unit: "%", scale: 100 },
  { key: "energy_to_break_j", label: "Energy", unit: "J", scale: 1 },
] as const;
type OutcomeKey = (typeof OUTCOMES)[number]["key"];

const PARAM_UNITS: Record<string, string> = {
  EffectiveLineEnergyDensity: "mJ/mm",
  LaserFillEnergyDensity: "mJ/mm",
  HotspotOverlapPercent: "%",
  LayerThickness: "µm",
  HeatingTargetPrint: "°C",
  HeatingTargetPrintBed: "°C",
  SurfaceTarget: "°C",
  SurfaceTarget2: "°C",
  BeginLayerTemperatureTarget: "°C",
  BedPreparationTemperatureTarget: "°C",
  TotalEnergyDensityPercent: "%",
  LaserOnPercent: "%",
  PowderVolumePercent: "%",
};

// "EffectiveLineEnergyDensity" -> "Effective Line Energy Density" — firmware
// field names are PascalCase; titles/pickers/tables show them spaced.
const paramLabel = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

const batchColor = (batch: string | null) =>
  batch ? BATCH_COLORS[batch] ?? CONTROL_COLOR : CONTROL_COLOR;

function meanStd(vals: number[]): { mean: number; std: number; n: number } | null {
  if (vals.length === 0) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std =
    vals.length > 1
      ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1))
      : 0;
  return { mean, std, n: vals.length };
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

// Viridis 5-stop ramp for the map view's property colormap — perceptually
// ordered low→high, colorblind-safe, legible in both themes.
const RAMP = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
function rampColor(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const hex = (s: string, j: number) => parseInt(s.slice(1 + 2 * j, 3 + 2 * j), 16);
  const ch = (j: number) => Math.round(hex(RAMP[i], j) + (hex(RAMP[i + 1], j) - hex(RAMP[i], j)) * f);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

// One marker per experiment condition (distinct X/Y parameter pair): the SLS
// analog of an LPBF power–velocity map. Color = mean outcome, size = n.
interface MapDatum {
  x: number;
  y: number;
  n: number;
  mean: number;
  std: number;
  batches: string[];
  profileNames: string[];
  profileId: string | null;
}

interface ScatterDatum {
  x: number;
  y: number;
  point?: ProcessMapPoint; // specimen series
  mean?: { std: number; n: number }; // mean series
  err?: number; // mean series ErrorBar (± SD), only when n > 1
}

function PointTooltip({
  active,
  payload,
  xLabel,
  yLabel,
}: {
  active?: boolean;
  payload?: { payload: ScatterDatum }[];
  xLabel: string;
  yLabel: string;
}) {
  const d = active && payload?.length ? payload[0].payload : null;
  if (!d) return null;
  return (
    <div className="border-2 border-border bg-background px-2 py-1.5 text-xs shadow-shadow">
      {d.point ? (
        <>
          <div className="font-heading">
            {d.point.sample_id}
            {d.point.batch_label && <span className="ml-1 opacity-60">· batch {d.point.batch_label}</span>}
          </div>
          {d.point.job_name && <div className="opacity-70">{d.point.job_name}</div>}
        </>
      ) : (
        <div className="font-heading">
          mean ± SD{d.mean && <span className="ml-1 opacity-60">· n={d.mean.n}</span>}
        </div>
      )}
      <div className="tabular-nums">
        {xLabel}: {fmt(d.x)}
      </div>
      <div className="tabular-nums">
        {yLabel}: {fmt(d.y)}
        {d.mean && d.mean.n > 1 && ` ± ${fmt(d.mean.std)}`}
      </div>
    </div>
  );
}

function MapTooltip({
  active,
  payload,
  xLabel,
  yLabel,
  outcomeLabel,
}: {
  active?: boolean;
  payload?: { payload: MapDatum }[];
  xLabel: string;
  yLabel: string;
  outcomeLabel: string;
}) {
  const d = active && payload?.length ? payload[0].payload : null;
  if (!d) return null;
  return (
    <div className="max-w-64 border-2 border-border bg-background px-2 py-1.5 text-xs shadow-shadow">
      <div className="font-heading">
        {outcomeLabel}: {fmt(d.mean)}
        {d.n > 1 && ` ± ${fmt(d.std)}`}
        <span className="ml-1 opacity-60">· n={d.n}</span>
      </div>
      <div className="tabular-nums">
        {xLabel}: {d.x}
      </div>
      <div className="tabular-nums">
        {yLabel}: {d.y}
      </div>
      {d.batches.length > 0 && <div className="opacity-70">batches {d.batches.join(", ")}</div>}
      {d.profileNames.map((name) => (
        <div key={name} className="truncate opacity-70">
          {name}
        </div>
      ))}
    </div>
  );
}

export function ProcessMap() {
  const navigate = useNavigate();
  const [resp, setResp] = useState<ProcessMapResp | null>(null);
  const [notWired, setNotWired] = useState(false);
  const [standard, setStandard] = useState<"D638" | "D790">("D790");
  const [view, setView] = useState<"map" | "trend">("map");
  const [xParam, setXParam] = useState("EffectiveLineEnergyDensity");
  const [yParam, setYParam] = useState("SurfaceTarget");
  const [outcome, setOutcome] = useState<OutcomeKey>("peak_stress_pa");
  const chartAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/process-map");
        if (res.status === 503 || res.status === 404) {
          if (!cancelled) setNotWired(true);
          return;
        }
        const data = (await res.json()) as ProcessMapResp;
        if (!cancelled) {
          setResp(data);
          setNotWired(false);
        }
      } catch {
        /* transient */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const points = resp?.points ?? [];
  const stdPoints = useMemo(
    () => points.filter((p) => p.standard === standard),
    [points, standard],
  );

  // Distinct non-null values per parameter (across BOTH standards) — the axis
  // picker flags parameters that actually vary vs. ones held constant so far.
  const paramValueCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const key of resp?.params ?? []) {
      const vals = new Set<number>();
      for (const p of points) {
        const v = p.params[key];
        if (v != null) vals.add(v);
      }
      m.set(key, vals.size);
    }
    return m;
  }, [resp, points]);

  // Outcome availability differs by standard (D638 rows carry only modulus;
  // peak/strain live on D790) — grey out empty options, hop off one if the
  // standard toggle empties the current selection.
  const outcomeCounts = useMemo(() => {
    const m = {} as Record<OutcomeKey, number>;
    for (const o of OUTCOMES) m[o.key] = stdPoints.filter((p) => p[o.key] != null).length;
    return m;
  }, [stdPoints]);
  useEffect(() => {
    if (stdPoints.length > 0 && outcomeCounts[outcome] === 0) {
      const first = OUTCOMES.find((o) => outcomeCounts[o.key] > 0);
      if (first) setOutcome(first.key);
    }
  }, [stdPoints, outcomeCounts, outcome]);

  const outcomeSpec = OUTCOMES.find((o) => o.key === outcome)!;
  const xUnit = PARAM_UNITS[xParam];
  const xLabel = xUnit ? `${paramLabel(xParam)} (${xUnit})` : paramLabel(xParam);
  const yUnit = PARAM_UNITS[yParam];
  const yParamLabel = yUnit ? `${paramLabel(yParam)} (${yUnit})` : paramLabel(yParam);
  const yLabel = `${outcomeSpec.label} (${outcomeSpec.unit})`;

  // One Scatter series per batch (stable batch colors), plus a grey
  // mean ± SD diamond per parameter value. Legend chips toggle batches on and
  // off; the series list keeps every batch (so hidden chips stay clickable)
  // while the mean recomputes from VISIBLE batches only.
  const [hiddenBatches, setHiddenBatches] = useState<Set<string>>(new Set());
  const [showMean, setShowMean] = useState(true);
  const toggleBatch = (b: string) =>
    setHiddenBatches((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });

  const { series, meanData } = useMemo(() => {
    const byBatch = new Map<string, ScatterDatum[]>();
    const byX = new Map<number, number[]>();
    for (const p of stdPoints) {
      const x = p.params[xParam];
      const raw = p[outcome];
      if (x == null || raw == null) continue;
      const y = raw * outcomeSpec.scale;
      const k = p.batch_label ?? "—";
      if (!byBatch.has(k)) byBatch.set(k, []);
      byBatch.get(k)!.push({ x, y, point: p });
      if (hiddenBatches.has(k)) continue;
      if (!byX.has(x)) byX.set(x, []);
      byX.get(x)!.push(y);
    }
    const series = [...byBatch.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([batch, data]) => ({ batch, data }));
    const meanData: ScatterDatum[] = [...byX.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, ys]) => {
        const s = meanStd(ys)!;
        return { x, y: s.mean, err: s.n > 1 ? s.std : undefined, mean: { std: s.std, n: s.n } };
      });
    return { series, meanData };
  }, [stdPoints, xParam, outcome, outcomeSpec.scale, hiddenBatches]);
  const visibleSeries = series.filter((s) => !hiddenBatches.has(s.batch));

  // Map view: group specimens into experiment conditions by (xParam, yParam).
  const mapData = useMemo(() => {
    const byKey = new Map<string, ProcessMapPoint[]>();
    for (const p of stdPoints) {
      const x = p.params[xParam];
      const y = p.params[yParam];
      if (x == null || y == null || p[outcome] == null) continue;
      const k = `${x}|${y}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(p);
    }
    const out: MapDatum[] = [...byKey.values()].map((pts) => {
      const s = meanStd(pts.map((p) => p[outcome]! * outcomeSpec.scale))!;
      const profileIds = new Set(pts.map((p) => p.print_profile_id).filter(Boolean));
      return {
        x: pts[0].params[xParam]!,
        y: pts[0].params[yParam]!,
        n: s.n,
        mean: s.mean,
        std: s.std,
        batches: [...new Set(pts.map((p) => p.batch_label).filter(Boolean))].sort() as string[],
        profileNames: [...new Set(pts.map((p) => p.profile_name).filter(Boolean))] as string[],
        profileId: profileIds.size === 1 ? [...profileIds][0] : null,
      };
    });
    return out.sort((a, b) => a.x - b.x || a.y - b.y);
  }, [stdPoints, xParam, yParam, outcome, outcomeSpec.scale]);

  const meanRange = useMemo(() => {
    if (mapData.length === 0) return null;
    const means = mapData.map((d) => d.mean);
    return { min: Math.min(...means), max: Math.max(...means) };
  }, [mapData]);
  const meanT = (mean: number) =>
    meanRange && meanRange.max > meanRange.min
      ? (mean - meanRange.min) / (meanRange.max - meanRange.min)
      : 0.5;

  // Export mirrors the on-page legend (HTML, not part of the chart svg) as
  // native svg elements appended below the plot.
  const handleExport = (format: ChartExportFormat) => {
    if (!chartAreaRef.current) return;
    const legend: ExportLegend | undefined =
      view === "map"
        ? meanRange
          ? {
              ramp: {
                stops: [...RAMP],
                min: fmt(meanRange.min),
                max: fmt(meanRange.max),
                label: yLabel,
              },
              note: "mean per condition · marker size = specimen count",
            }
          : undefined
        : {
            items: [
              ...visibleSeries.map((s) => ({
                color: batchColor(s.batch === "—" ? null : s.batch),
                label: s.batch === "—" ? "no batch" : `Batch ${s.batch}`,
              })),
              ...(showMean
                ? [{ color: CONTROL_COLOR, label: "mean ± SD", shape: "diamond" as const }]
                : []),
            ],
          };
    void exportChart(
      chartAreaRef.current,
      format,
      `process-map-${view}-${standard}-${outcome.replace(/_pa$|_j$/, "")}`,
      legend,
    ).catch(() => {});
  };

  // Summary table: one row per distinct value of the X parameter, all
  // outcomes side by side. Rows that map to a single profile link to it.
  const groups = useMemo(() => {
    const byX = new Map<number, ProcessMapPoint[]>();
    for (const p of stdPoints) {
      const x = p.params[xParam];
      if (x == null) continue;
      if (!byX.has(x)) byX.set(x, []);
      byX.get(x)!.push(p);
    }
    return [...byX.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, pts]) => {
        const profileIds = new Set(pts.map((p) => p.print_profile_id).filter(Boolean));
        const stats = Object.fromEntries(
          OUTCOMES.map((o) => [
            o.key,
            meanStd(pts.map((p) => p[o.key]).filter((v): v is number => v != null).map((v) => v * o.scale)),
          ]),
        ) as Record<OutcomeKey, ReturnType<typeof meanStd>>;
        return {
          x,
          n: pts.length,
          batches: [...new Set(pts.map((p) => p.batch_label).filter(Boolean))].sort() as string[],
          profileId: profileIds.size === 1 ? [...profileIds][0] : null,
          profileName: pts.find((p) => p.profile_name)?.profile_name ?? null,
          stats,
        };
      });
  }, [stdPoints, xParam]);

  return (
    <div className="p-4 flex flex-col gap-4">
      {notWired && (
        <Card>
          <CardContent className="py-4 text-sm opacity-70">
            No ASTM specimens found — run <code>sls-sync-reference</code> to
            import the Agentic-SLS-ASTM dataset. Once synced, this page maps
            mechanical outcomes across the printed process-parameter space.
          </CardContent>
        </Card>
      )}

      {!notWired && (
        <>
          <Card className="shrink-0">
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-sm">
                Process map
                <span className="ml-2 font-base opacity-60">
                  {standard === "D638" ? "tensile · D638" : "3-pt flex · D790"} ·{" "}
                  {view === "map"
                    ? `${mapData.reduce((a, d) => a + d.n, 0)} specimens · ${mapData.length} conditions`
                    : `${visibleSeries.reduce((a, s) => a + s.data.length, 0)} specimens`}
                </span>
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1">
                  {(["map", "trend"] as const).map((v) => (
                    <Button
                      key={v}
                      size="sm"
                      variant={view === v ? "default" : "neutral"}
                      className="h-7 px-2 text-xs"
                      onClick={() => setView(v)}
                    >
                      {v === "map" ? "Map" : "Trend"}
                    </Button>
                  ))}
                </div>
                <select
                  value={xParam}
                  onChange={(e) => setXParam(e.target.value)}
                  className="h-8 rounded-base border-2 border-border bg-background px-2 text-xs font-base"
                  aria-label="X-axis parameter"
                >
                  {(resp?.params ?? [xParam]).map((k) => {
                    const n = paramValueCounts.get(k) ?? 0;
                    return (
                      <option key={k} value={k}>
                        {paramLabel(k)}
                        {n > 1 ? ` (${n} values)` : " (fixed)"}
                      </option>
                    );
                  })}
                </select>
                {view === "map" && (
                  <select
                    value={yParam}
                    onChange={(e) => setYParam(e.target.value)}
                    className="h-8 rounded-base border-2 border-border bg-background px-2 text-xs font-base"
                    aria-label="Y-axis parameter"
                  >
                    {(resp?.params ?? [yParam]).map((k) => {
                      const n = paramValueCounts.get(k) ?? 0;
                      return (
                        <option key={k} value={k}>
                          {paramLabel(k)}
                          {n > 1 ? ` (${n} values)` : " (fixed)"}
                        </option>
                      );
                    })}
                  </select>
                )}
                <div className="flex gap-1">
                  {OUTCOMES.map((o) => (
                    <Button
                      key={o.key}
                      size="sm"
                      variant={outcome === o.key ? "default" : "neutral"}
                      className="h-7 px-2 text-xs"
                      disabled={outcomeCounts[o.key] === 0}
                      onClick={() => setOutcome(o.key)}
                    >
                      {o.label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {(["D638", "D790"] as const).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={standard === s ? "default" : "neutral"}
                      className="h-7 px-2 text-xs"
                      onClick={() => setStandard(s)}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* export target: the visible view's rendered chart svg; the
                  export buttons float over the chart's top-right corner */}
              <div ref={chartAreaRef} className="relative">
              {resp && (
                <div className="absolute right-2 top-2 z-10">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="neutral" className="h-7 px-2 text-xs" title="Export chart">
                        <Download className="size-3.5" />
                        Export
                        <ChevronDown className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {(["png", "svg", "pdf"] as const).map((f) => (
                        <DropdownMenuItem
                          key={f}
                          className="text-xs uppercase"
                          onClick={() => handleExport(f)}
                        >
                          {f}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              {!resp ? (
                <div className="py-8 text-center text-sm opacity-60">loading…</div>
              ) : view === "map" ? (
                mapData.length === 0 ? (
                  <div className="py-8 text-center text-sm opacity-60">
                    No {standard} specimens with {paramLabel(xParam)} + {paramLabel(yParam)} + {outcomeSpec.label}.
                  </div>
                ) : (
                  <>
                    <ChartContainer config={{}} className="aspect-square w-full">
                      <ScatterChart margin={{ left: 12, right: 16, top: 8, bottom: 40 }}>
                        <CartesianGrid strokeOpacity={0.3} />
                        <XAxis
                          dataKey="x"
                          type="number"
                          domain={["auto", "auto"]}
                          padding={{ left: 24, right: 24 }}
                          tickLine={false}
                          axisLine={false}
                          tickMargin={8}
                          className="text-xs"
                          label={{ value: xLabel, position: "insideBottom", offset: -26, fontSize: 14 }}
                        />
                        <YAxis
                          dataKey="y"
                          type="number"
                          domain={["auto", "auto"]}
                          tickLine={false}
                          axisLine={false}
                          width={70}
                          tickCount={12}
                          className="text-xs"
                          label={{ value: yParamLabel, angle: -90, position: "insideLeft", fontSize: 14 }}
                        />
                        <ZAxis dataKey="n" range={[120, 500]} />
                        <Tooltip
                          cursor={{ strokeDasharray: "3 3" }}
                          content={
                            <MapTooltip xLabel={xLabel} yLabel={yParamLabel} outcomeLabel={yLabel} />
                          }
                        />
                        <Scatter
                          data={mapData}
                          isAnimationActive={false}
                          onClick={(d: MapDatum) => {
                            if (d?.profileId)
                              navigate(`/profiles/${d.profileId}`, {
                                state: { breadcrumb: d.profileNames[0] },
                              });
                          }}
                          className="cursor-pointer"
                        >
                          {mapData.map((d, i) => (
                            <Cell key={i} fill={rampColor(meanT(d.mean))} />
                          ))}
                        </Scatter>
                      </ScatterChart>
                    </ChartContainer>
                    {meanRange && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-heading">{yLabel}</span>
                        <span className="tabular-nums">{fmt(meanRange.min)}</span>
                        <span
                          className="h-2.5 w-40 border border-border"
                          style={{ background: `linear-gradient(to right, ${RAMP.join(",")})` }}
                        />
                        <span className="tabular-nums">{fmt(meanRange.max)}</span>
                        <span className="opacity-60">
                          mean per condition · marker size = specimen count
                        </span>
                      </div>
                    )}
                  </>
                )
              ) : series.length === 0 ? (
                <div className="py-8 text-center text-sm opacity-60">
                  No {standard} specimens with {paramLabel(xParam)} + {outcomeSpec.label}.
                </div>
              ) : (
                <>
                  <ChartContainer config={{}} className="aspect-square w-full">
                    <ScatterChart margin={{ left: 12, right: 16, top: 8, bottom: 40 }}>
                      <CartesianGrid strokeOpacity={0.3} />
                      <XAxis
                        dataKey="x"
                        type="number"
                        domain={["auto", "auto"]}
                        padding={{ left: 24, right: 24 }}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        className="text-xs"
                        label={{ value: xLabel, position: "insideBottom", offset: -26, fontSize: 14 }}
                      />
                      <YAxis
                        dataKey="y"
                        type="number"
                        domain={["auto", "auto"]}
                        tickLine={false}
                        axisLine={false}
                        width={70}
                        tickCount={12}
                        className="text-xs"
                        label={{ value: yLabel, angle: -90, position: "insideLeft", fontSize: 14 }}
                      />
                      <Tooltip
                        cursor={{ strokeDasharray: "3 3" }}
                        content={<PointTooltip xLabel={xLabel} yLabel={yLabel} />}
                      />
                      {visibleSeries.map((s) => (
                        <Scatter
                          key={s.batch}
                          data={s.data}
                          fill={batchColor(s.batch === "—" ? null : s.batch)}
                          isAnimationActive={false}
                          onClick={(d: { point?: ProcessMapPoint }) => {
                            const p = d?.point;
                            if (p?.job_id)
                              navigate(`/jobs/${p.job_id}`, {
                                state: { breadcrumb: p.job_name ?? undefined },
                              });
                          }}
                          className="cursor-pointer"
                        />
                      ))}
                      {showMean && (
                        <Scatter
                          data={meanData}
                          fill={CONTROL_COLOR}
                          shape="diamond"
                          isAnimationActive={false}
                        >
                          <ErrorBar dataKey="err" direction="y" width={5} strokeWidth={1.5} stroke={CONTROL_COLOR} />
                        </Scatter>
                      )}
                    </ScatterChart>
                  </ChartContainer>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {series.map((s) => {
                      const hidden = hiddenBatches.has(s.batch);
                      return (
                        <button
                          key={s.batch}
                          type="button"
                          onClick={() => toggleBatch(s.batch)}
                          title={hidden ? "Show batch" : "Hide batch"}
                          className={cn(
                            "inline-flex cursor-pointer items-center gap-1 text-[11px]",
                            hidden && "opacity-40 line-through",
                          )}
                        >
                          <span
                            className="inline-block size-2.5 rounded-full border border-border"
                            style={{ background: batchColor(s.batch === "—" ? null : s.batch) }}
                          />
                          {s.batch === "—" ? "no batch" : `Batch ${s.batch}`}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setShowMean((v) => !v)}
                      title={showMean ? "Hide mean ± SD" : "Show mean ± SD"}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1 text-[11px]",
                        !showMean && "opacity-40 line-through",
                      )}
                    >
                      <span
                        className="inline-block size-2.5 rotate-45 border border-border"
                        style={{ background: CONTROL_COLOR }}
                      />
                      mean ± SD
                    </button>
                  </div>
                </>
              )}
              </div>
            </CardContent>
          </Card>

          {groups.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">
                  By {paramLabel(xParam)}
                  <span className="ml-2 font-base opacity-60">{standard} specimens, mean ± SD</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="border-2 border-border">
                  <Table className="table-fixed border-0">
                    <TableHeader>
                      <TableRow>
                        <TableHead
                          className="h-8 px-2 text-xs font-heading w-32 truncate"
                          title={xUnit ? `${paramLabel(xParam)} (${xUnit})` : paramLabel(xParam)}
                        >
                          {paramLabel(xParam)}
                          {xUnit ? ` (${xUnit})` : ""}
                        </TableHead>
                        <TableHead className="h-8 px-2 text-xs font-heading w-14 text-right">n</TableHead>
                        <TableHead className="h-8 px-2 text-xs font-heading w-24">batches</TableHead>
                        {OUTCOMES.map((o) => (
                          <TableHead key={o.key} className="h-8 px-2 text-xs font-heading text-right">
                            {o.label} ({o.unit})
                          </TableHead>
                        ))}
                        <TableHead className="h-8 px-2 text-xs font-heading">profile</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {groups.map((g) => (
                        <TableRow
                          key={g.x}
                          onClick={() =>
                            g.profileId &&
                            navigate(`/profiles/${g.profileId}`, {
                              state: { breadcrumb: g.profileName ?? undefined },
                            })
                          }
                          className={cn(
                            "bg-background text-foreground",
                            g.profileId && "cursor-pointer hover:bg-secondary-background",
                          )}
                        >
                          <TableCell className="px-2 py-1.5 text-xs tabular-nums font-heading">{g.x}</TableCell>
                          <TableCell className="px-2 py-1.5 text-xs text-right tabular-nums">{g.n}</TableCell>
                          <TableCell className="px-2 py-1.5 text-xs">{g.batches.join(", ") || "—"}</TableCell>
                          {OUTCOMES.map((o) => {
                            const s = g.stats[o.key];
                            return (
                              <TableCell key={o.key} className="px-2 py-1.5 text-xs text-right tabular-nums">
                                {s ? (s.n > 1 ? `${fmt(s.mean)} ± ${fmt(s.std)}` : fmt(s.mean)) : "—"}
                              </TableCell>
                            );
                          })}
                          <TableCell className="px-2 py-1.5 text-xs truncate" title={g.profileName ?? undefined}>
                            {g.profileName ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
