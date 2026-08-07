import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Download, Search } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ChartContainer } from "@/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportChart, type ChartExportFormat } from "@/lib/chartExport";

// Tests — the human-facing view of every ASTM specimen we've collected
// (astm_specimens, flattened metrics). Served by /api/astm; one row per tested
// specimen. Control specimens (PLA/PETG/FormLabs) carry no job link.

export interface AstmRow {
  standard: string;
  sample_id: string;
  batch_label: string | null;
  material_class: string | null;
  test_date: string | null;
  job_id: string | null;
  print_date: string | null;
  inova_session_id: string | null;
  modulus_pa: number | null;
  peak_load_n: number | null;
  peak_stress_pa: number | null;
  strain_at_peak: number | null;
  stress_at_break_pa: number | null;
  strain_at_break: number | null;
  energy_to_break_j: number | null;
  yield_stress_pa: number | null;
  strain_at_yield: number | null;
  test_end_reason: string | null;
  notes: string | null;
  job_name: string | null;
}

// Pa → MPa, strain (fraction) → %.
function mpa(pa: number | null): string {
  if (pa == null) return "—";
  return `${(pa / 1e6).toFixed(pa / 1e6 >= 100 ? 0 : 1)}`;
}
function pct(strain: number | null): string {
  if (strain == null) return "—";
  return `${(strain * 100).toFixed(1)}%`;
}

// ── sortable column header (same pattern as Builds.tsx / Jobs.tsx) ────────────

type SortKey =
  | "standard"
  | "sample_id"
  | "material_class"
  | "test_date"
  | "job_name"
  | "modulus_pa"
  | "peak_stress_pa"
  | "strain_at_break";
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

// ── stress–strain composite ──────────────────────────────────────────────────
// Mimics the HuggingFace dataset's composite figure (Agentic-SLS-ASTM
// assets/{standard}_composite.png): one thin line per specimen, X = strain, Y =
// stress (MPa), colored by print batch. Curves come from /api/astm/curves
// (resampled onto a shared strain grid). Main view = SLS batches + FormLabs
// PA12GF control; PLA/PETG filament controls are excluded (they print at much
// higher stress and squash the SLS curves — the dataset gives them their own
// figure).

// Same palette as the dataset's scripts/plots/_lib.py BATCH_COLORS, so batch C
// is the same green here as in the published figures. Exported: the Process
// Map page colors its specimen points by the same batch palette.
export const BATCH_COLORS: Record<string, string> = {
  A: "#1f77b4", B: "#ff7f0e", C: "#2ca02c", D: "#d62728", E: "#9467bd",
  F: "#8c564b", G: "#e377c2", H: "#bcbd22", I: "#17becf", J: "#aec7e8", J_MB: "#08519c",
};
export const CONTROL_COLOR = "#7f7f7f"; // FormLabs / non-batch
const FILAMENT_CONTROLS = new Set(["PLA", "PETG"]);

interface Curve {
  sample_id: string;
  batch: string | null;
  material: string | null;
  stress: (number | null)[];
}
interface CurveResp {
  standard: string;
  grid: number[];
  specimens: Curve[];
}

const seriesColor = (batch: string | null) => (batch ? BATCH_COLORS[batch] ?? CONTROL_COLOR : CONTROL_COLOR);
const groupKey = (s: Curve) => s.batch ?? s.material ?? "—";
const groupLabel = (s: Curve) =>
  s.batch ? `Batch ${s.batch}` : s.material === "PA12GF_FL" ? "FormLabs PA12GF" : s.material ?? "—";

function AstmChart() {
  const [standard, setStandard] = useState<"D638" | "D790">("D790");
  const [resp, setResp] = useState<CurveResp | null>(null);
  const [loading, setLoading] = useState(true);
  const chartAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/astm/curves?standard=${standard}`)
      .then((r) => r.json())
      .then((d: CurveResp) => {
        if (!cancelled) {
          setResp(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [standard]);

  const specimens = useMemo(
    () => (resp?.specimens ?? []).filter((s) => !FILAMENT_CONTROLS.has(s.material ?? "")),
    [resp],
  );

  // Legend chips toggle whole batches/groups on and off; hidden groups drop
  // out of the chart, the X domain, and the export.
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const visibleSpecimens = useMemo(
    () => specimens.filter((s) => !hiddenGroups.has(groupKey(s))),
    [specimens, hiddenGroups],
  );

  // Wide format for recharts: each row is a strain value holding every
  // specimen's stress there (null past that specimen's break → its line ends).
  const data = useMemo(
    () =>
      (resp?.grid ?? []).map((g, i) => {
        const pt: Record<string, number | null> = { strain: g };
        for (const s of specimens) pt[s.sample_id] = s.stress[i];
        return pt;
      }),
    [resp, specimens],
  );

  // X domain = furthest strain any *displayed* specimen reaches. The shared
  // grid spans all specimens including the excluded PLA/PETG controls (which
  // elongate far more), so keying off the grid max would scrunch the SLS
  // curves into the left ~13% of the axis for D638.
  const xMax = useMemo(() => {
    const grid = resp?.grid ?? [];
    let lastIdx = 0;
    for (let i = 0; i < grid.length; i++) {
      if (visibleSpecimens.some((s) => s.stress[i] != null)) lastIdx = i;
    }
    return grid[lastIdx] ?? 1;
  }, [resp, visibleSpecimens]);

  // One legend entry per batch/group (not per specimen), SLS batches then FormLabs.
  const legend = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; color: string }>();
    for (const s of specimens) {
      const k = groupKey(s);
      if (!seen.has(k)) seen.set(k, { key: k, label: groupLabel(s), color: seriesColor(s.batch) });
    }
    return [...seen.entries()]
      .sort((a, b) =>
        a[0] === "PA12GF_FL" ? 1 : b[0] === "PA12GF_FL" ? -1 : a[0].localeCompare(b[0]),
      )
      .map(([, v]) => v);
  }, [specimens]);

  // ChartContainer forces black stroke on every path; override per-specimen to
  // the batch color (scoped to this card, wins on specificity + !important).
  const strokeCss = visibleSpecimens
    .map((s, i) => `.astm-lines .ln-${i} .recharts-curve{stroke:${seriesColor(s.batch)}!important}`)
    .join("");

  // Same export pipeline as the Process Map page: current chart svg + the
  // batch legend redrawn as native svg elements.
  const handleExport = (format: ChartExportFormat) => {
    if (!chartAreaRef.current) return;
    void exportChart(chartAreaRef.current, format, `astm-stress-strain-${standard}`, {
      items: legend
        .filter((l) => !hiddenGroups.has(l.key))
        .map((l) => ({ color: l.color, label: l.label })),
    }).catch(() => {});
  };

  return (
    <Card className="shrink-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">
          Stress–strain composite
          <span className="ml-2 font-base opacity-60">
            {standard === "D638" ? "tensile · D638" : "3-pt flex · D790"} · {visibleSpecimens.length} specimens
          </span>
        </CardTitle>
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
      </CardHeader>
      <CardContent>
        {loading && !resp ? (
          <div className="py-8 text-center text-sm opacity-60">loading curves…</div>
        ) : specimens.length === 0 ? (
          <div className="py-8 text-center text-sm opacity-60">No curves for {standard}.</div>
        ) : (
          <div ref={chartAreaRef} className="astm-lines relative">
            <style dangerouslySetInnerHTML={{ __html: strokeCss }} />
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
            <ChartContainer config={{}} className="aspect-square w-full">
              <LineChart data={data} margin={{ left: 12, right: 12, top: 8, bottom: 40 }}>
                <CartesianGrid strokeOpacity={0.3} />
                <XAxis
                  dataKey="strain"
                  type="number"
                  domain={[0, xMax]}
                  allowDataOverflow
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  className="text-xs"
                  tickFormatter={(v) => Number(v).toFixed(3)}
                  label={{ value: "Strain (mm/mm)", position: "insideBottom", offset: -26, fontSize: 14 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={70}
                  tickCount={12}
                  className="text-xs"
                  label={{ value: "Stress (MPa)", angle: -90, position: "insideLeft", fontSize: 14 }}
                />
                {visibleSpecimens.map((s, i) => (
                  <Line
                    key={s.sample_id}
                    className={`ln-${i}`}
                    type="monotone"
                    dataKey={s.sample_id}
                    stroke={seriesColor(s.batch)}
                    strokeWidth={1.1}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ChartContainer>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {legend.map((l) => {
                const hidden = hiddenGroups.has(l.key);
                return (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => toggleGroup(l.key)}
                    title={hidden ? "Show group" : "Hide group"}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 text-[11px]",
                      hidden && "opacity-40 line-through",
                    )}
                  >
                    <span
                      className="inline-block h-2 w-3 rounded-[1px] border border-border"
                      style={{ background: l.color }}
                    />
                    {l.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AstmTests() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AstmRow[] | null>(null);
  const [notWired, setNotWired] = useState(false);
  const [query, setQuery] = useState("");

  // Sortable + paginated; newest test first by default. Text columns default to
  // ascending on first click (same convention as the other data-tables).
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "test_date", dir: -1 });
  const handleSort = (key: SortKey) => {
    const textCol = key === "standard" || key === "sample_id" || key === "material_class" || key === "job_name";
    setSort((s) =>
      s.key === key ? { key, dir: (s.dir * -1) as SortDir } : { key, dir: textCol ? 1 : -1 },
    );
    setPage(0);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/astm");
        if (res.status === 503 || res.status === 404) {
          if (!cancelled) setNotWired(true);
          return;
        }
        const data = (await res.json()) as AstmRow[];
        if (!cancelled) {
          setRows(data);
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

  const q = query.trim().toLowerCase();
  const filtered = (rows ?? []).filter((r) =>
    q === "" ||
    r.standard.toLowerCase().includes(q) ||
    r.sample_id.toLowerCase().includes(q) ||
    (r.batch_label ?? "").toLowerCase().includes(q) ||
    (r.material_class ?? "").toLowerCase().includes(q) ||
    (r.job_name ?? "").toLowerCase().includes(q),
  );
  const sorted = [...filtered].sort((a, b) => {
    let cmp: number;
    switch (sort.key) {
      case "standard":
        cmp = a.standard.localeCompare(b.standard);
        break;
      case "sample_id":
        cmp = a.sample_id.localeCompare(b.sample_id);
        break;
      case "material_class":
        cmp = (a.material_class ?? "").localeCompare(b.material_class ?? "");
        break;
      case "job_name":
        cmp = (a.job_name ?? "").localeCompare(b.job_name ?? "");
        break;
      case "test_date":
        cmp = new Date(a.test_date ?? 0).getTime() - new Date(b.test_date ?? 0).getTime();
        break;
      case "modulus_pa":
        cmp = (a.modulus_pa ?? 0) - (b.modulus_pa ?? 0);
        break;
      case "peak_stress_pa":
        cmp = (a.peak_stress_pa ?? 0) - (b.peak_stress_pa ?? 0);
        break;
      case "strain_at_break":
        cmp = (a.strain_at_break ?? 0) - (b.strain_at_break ?? 0);
        break;
      default:
        cmp = 0;
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
            placeholder="Search standard / sample / batch / material / job…"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {notWired && (
        <Card>
          <CardContent className="py-4 text-sm opacity-70">
            No ASTM specimens found — run <code>sls-sync-reference</code> to
            import the Agentic-SLS-ASTM dataset. Once synced, this page lists
            every tested specimen with its mechanical metrics.
          </CardContent>
        </Card>
      )}

      {!notWired && (
        <>
          {rows && <AstmChart />}
          {!rows ? (
            <div className="text-sm opacity-60">loading…</div>
          ) : sorted.length === 0 ? (
            <div className="text-sm opacity-60">No specimens match.</div>
          ) : (
            <div className="flex flex-col min-h-0 border-2 border-border [&>div]:min-h-0">
              <Table className="table-fixed border-0">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <SortHead label="standard" sortKey="standard" sort={sort} onSort={handleSort} className="w-24" />
                    <SortHead label="sample" sortKey="sample_id" sort={sort} onSort={handleSort} className="w-28" />
                    <SortHead label="material" sortKey="material_class" sort={sort} onSort={handleSort} className="w-24" />
                    <SortHead label="job" sortKey="job_name" sort={sort} onSort={handleSort} />
                    <SortHead label="tested" sortKey="test_date" sort={sort} onSort={handleSort} className="w-28" />
                    <SortHead label="modulus (MPa)" sortKey="modulus_pa" sort={sort} onSort={handleSort} className="w-28 text-right" />
                    <SortHead label="peak σ (MPa)" sortKey="peak_stress_pa" sort={sort} onSort={handleSort} className="w-28 text-right" />
                    <SortHead label="ε break" sortKey="strain_at_break" sort={sort} onSort={handleSort} className="w-20 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((r) => (
                    <TableRow
                      key={`${r.standard}/${r.sample_id}`}
                      onClick={() => r.job_id && navigate(`/jobs/${r.job_id}`)}
                      className={cn(
                        "bg-background text-foreground",
                        r.job_id && "cursor-pointer hover:bg-secondary-background",
                      )}
                    >
                      <TableCell className="px-2 py-1.5 text-xs font-heading whitespace-nowrap">{r.standard}</TableCell>
                      <TableCell className="px-2 py-1.5 text-xs truncate" title={r.sample_id}>
                        {r.sample_id}
                        {r.batch_label && (
                          <span className="ml-1 opacity-50">· {r.batch_label}</span>
                        )}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-xs">
                        {r.material_class ? <Badge variant="neutral">{r.material_class}</Badge> : "—"}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-xs truncate" title={r.job_name ?? undefined}>
                        {r.job_name ?? <span className="opacity-50">control</span>}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-xs whitespace-nowrap">
                        {r.test_date ? new Date(r.test_date).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-xs text-right tabular-nums">{mpa(r.modulus_pa)}</TableCell>
                      <TableCell className="px-2 py-1.5 text-xs text-right tabular-nums">{mpa(r.peak_stress_pa)}</TableCell>
                      <TableCell className="px-2 py-1.5 text-xs text-right tabular-nums">{pct(r.strain_at_break)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pageCount > 1 && (
            <div className="flex items-center gap-2 shrink-0">
              <div className="text-xs opacity-60 mr-auto">
                Page {safePage + 1} of {pageCount} · {sorted.length} specimens
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
    </div>
  );
}
