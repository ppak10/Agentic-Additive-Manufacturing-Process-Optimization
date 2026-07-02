import { useEffect, useMemo, useState } from "react";
import { Scissors, RotateCcw, AlertTriangle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePrintingObjects, excludePrintingObject, type PrintingObject } from "@/hooks/usePrintingObjects";
import { usePlotterVersion } from "@/hooks/usePlotterVersion";
import { usePlotterObjects, type PlotterObjectsState } from "@/hooks/usePlotterObjects";
import { useJob } from "@/hooks/useJob";
import { useChamber } from "@/hooks/useChamber";
import { BuildLayout3D } from "@/panels/BuildLayout3D";

// Build Layout: parts list of the currently-printing job + a 2D plot of the
// active layer with a per-part mask overlay. Mirrors the vanilla SLS4All
// /live/Plot UX (single-radio-select + contextual include/exclude button +
// confirmation modal), wired to the plugin's /printing/objects and
// /plotter/objects/{id}/mask.png endpoints proxied through the recorder.

function GroupHeading({ name, count, excludedCount }: { name: string; count: number; excludedCount: number }) {
  return (
    <div className="flex items-baseline justify-between pt-2 first:pt-0">
      <span className="text-xs font-heading">{name}</span>
      <span className="text-[10px] opacity-60">
        {count} {count === 1 ? "instance" : "instances"}
        {excludedCount > 0 && <span className="text-red-600 dark:text-red-400 ml-1">· {excludedCount} excluded</span>}
      </span>
    </div>
  );
}

function ObjectRow({
  obj,
  selected,
  hovered,
  onSelect,
  onHover,
}: {
  obj: PrintingObject;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
}) {
  return (
    <label
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cn(
        "flex items-center gap-2 px-2 py-1 rounded-base border-2 cursor-pointer transition-all",
        selected
          ? "border-border bg-main/20"
          : hovered
            ? "border-border bg-secondary-background"
            : "border-transparent hover:border-border hover:bg-secondary-background",
      )}
    >
      <input
        type="radio"
        name="selected-printing-object"
        className="size-3"
        checked={selected}
        onChange={onSelect}
      />
      <span className="text-xs flex-1 truncate">
        #{obj.id}
        <span className="opacity-50 ml-1">({shortHash(obj.hash)})</span>
      </span>
      {obj.isExcluded && (
        <Badge variant="neutral" className="gap-1 text-[10px] py-0">
          <Scissors className="size-2.5" /> excluded
        </Badge>
      )}
    </label>
  );
}

function shortHash(h: string | null | undefined): string {
  return h ? h.slice(0, 7) : "—";
}

function groupObjects(objects: PrintingObject[]): Map<string, PrintingObject[]> {
  const groups = new Map<string, PrintingObject[]>();
  for (const obj of objects) {
    const g = groups.get(obj.name) ?? [];
    g.push(obj);
    groups.set(obj.name, g);
  }
  return groups;
}

function ConfirmModal({
  obj,
  action,
  onConfirm,
  onCancel,
  busy,
  error,
}: {
  obj: PrintingObject;
  action: "exclude" | "include";
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={busy ? undefined : onCancel} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <Card className="max-w-md w-full pointer-events-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {action === "exclude" ? <Scissors className="size-4" /> : <RotateCcw className="size-4" />}
              <span>{action === "exclude" ? "Exclude from print" : "Include back in print"}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-xs">
            <p>
              {action === "exclude" ? "Stop printing" : "Resume printing"}{" "}
              <span className="font-heading">{obj.name}</span>{" "}
              <span className="opacity-60">(Object #{obj.id})</span>
              {action === "exclude" ? " for the rest of this print?" : "?"}
            </p>
            <p className="opacity-60">
              {action === "exclude"
                ? "The laser will skip this object on all remaining layers. This is reversible while the print is still running."
                : "The laser will resume drawing this object on the next layer."}
            </p>
            {error && (
              <div className="flex items-start gap-2 text-red-600 dark:text-red-400">
                <AlertTriangle className="size-3.5 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button variant="default" size="sm" onClick={onConfirm} disabled={busy}>
                {busy ? "Working…" : action === "exclude" ? "Exclude" : "Include"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// Client-side SVG render of the current-layer object outlines. One <polygon>
// per object from /api/plotter/objects, colored by isExcluded (from
// /api/printing/objects, joined by id) and highlighted when selected.
// Coords are plotter raster pixels; the SVG viewBox makes the scaling
// transparent. vectorEffect="non-scaling-stroke" keeps strokes crisp at
// any container size.
function BuildLayoutSvg({
  plotterObjects,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
}: {
  plotterObjects: PlotterObjectsState | null;
  selectedId: number | null;
  hoveredId: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  const width = plotterObjects?.width ?? 500;
  const height = plotterObjects?.height ?? 500;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      className="block w-full h-full"
    >
      {plotterObjects?.objects.map((obj) => {
        const isSelected = obj.id === selectedId;
        const isHovered = obj.id === hoveredId;
        // CodePlotterMarkedObject.RelativeOutline is normalized (0..1) over
        // the plotter raster — scale by width/height to land in the viewBox.
        const points = obj.outline.map(([x, y]) => `${x * width},${y * height}`).join(" ");
        return (
          <polygon
            key={obj.id}
            points={points}
            vectorEffect="non-scaling-stroke"
            onClick={() => onSelect(obj.id)}
            onMouseEnter={() => onHover(obj.id)}
            onMouseLeave={() => onHover(null)}
            className={cn(
              "cursor-pointer transition-all fill-main/25 stroke-main/80",
              // Hover (from list OR plot) brightens the fill — selection
              // still wins for visual emphasis if both apply. Excluded
              // parts simply don't appear here (firmware omits them from
              // /plotter/objects); the list-row badge carries that signal.
              isHovered && !isSelected && "!fill-main/45 stroke-foreground/70 [stroke-width:2]",
              isSelected && "!fill-main/60 stroke-foreground [stroke-width:3]",
            )}
          />
        );
      })}
      {plotterObjects && plotterObjects.objects.length === 0 && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground/40 text-[18px]"
        >
          no objects on current layer
        </text>
      )}
      {!plotterObjects && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground/40 text-[18px]"
        >
          loading…
        </text>
      )}
    </svg>
  );
}

export function BuildLayoutPanel() {
  const { objects, unavailable, refresh } = usePrintingObjects(2000);
  const plotter = usePlotterVersion(1000);
  const plotterObjects = usePlotterObjects(1000);
  // The plotter's own layerCount/currentLayer is unreliable for the real
  // print position (it's the plotter's internal layer index, not the job's).
  // Use the job status for the user-facing "layer X / Y" header text.
  const job = useJob(1000);
  const chamber = useChamber();
  // Phase-1 placeholder slice thickness (typical SLS). When we have a
  // /api/print-profile endpoint we'll pull the real value.
  const LAYER_MM = 0.1;
  // phaseDone/phaseTotal are per-phase counters — during Heating, PrintCap,
  // Cooling, etc. they reflect that phase's progress (e.g. heating steps),
  // NOT the layer count. Cache the last-seen values when phase === "Layers"
  // so the 3D chamber height and layer-plane position stay meaningful
  // through phase transitions (Heating → Layers → Cooling).
  const [rememberedLayers, setRememberedLayers] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (job?.phase === "Layers" && job.phaseDone != null && job.phaseTotal != null) {
      setRememberedLayers({ done: job.phaseDone, total: job.phaseTotal });
    }
  }, [job?.phase, job?.phaseDone, job?.phaseTotal]);
  const layerZ = rememberedLayers ? rememberedLayers.done * LAYER_MM : null;
  // Shrink the 3D chamber's Z to the actual print stack (layers × thickness).
  // Falls back to the full chamber height when we haven't observed the
  // Layers phase yet (e.g. still heating on first boot of the dashboard).
  const printHeightMM = rememberedLayers ? rememberedLayers.total * LAYER_MM : null;
  const effectiveChamber =
    chamber && printHeightMM != null
      ? { ...chamber, sizeZ: Math.max(printHeightMM, 1) }
      : chamber;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [pending, setPending] = useState<{ obj: PrintingObject; action: "exclude" | "include" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const groups = useMemo(() => groupObjects(objects ?? []), [objects]);
  const selected = useMemo(() => objects?.find((o) => o.id === selectedId) ?? null, [objects, selectedId]);
  const totalCount = objects?.length ?? 0;
  const excludedCount = objects?.filter((o) => o.isExcluded).length ?? 0;

  const onConfirm = async () => {
    if (!pending) return;
    setBusy(true);
    setPendingError(null);
    try {
      await excludePrintingObject(pending.obj.id, pending.action === "exclude");
      setPending(null);
      refresh();
    } catch (e) {
      setPendingError((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // Empty / unavailable / no-active-print states get a single short blurb
  // rather than a half-rendered card — feature is meaningless without data.
  const emptyMessage = unavailable
    ? "Plugin endpoint unavailable. Build Layout requires the Inova-API-Plugin with /printing/objects (Pending deploy)."
    : objects === null
      ? "Loading build layout…"
      : objects.length === 0
        ? "No active print — Build Layout shows parts during printing only."
        : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>Build layout</span>
            {rememberedLayers && objects && objects.length > 0 && (
              <span className="opacity-60 font-base text-[11px]">
                · layer {rememberedLayers.done} / {rememberedLayers.total}
                {job?.phase && job.phase !== "Layers" && <span className="ml-1 opacity-70">({job.phase.toLowerCase()})</span>}
              </span>
            )}
            {objects && objects.length > 0 && (
              <Badge variant={excludedCount > 0 ? "default" : "neutral"} className="ml-1">
                {totalCount} objects{excludedCount > 0 && ` · ${excludedCount} excluded`}
              </Badge>
            )}
            {plotterObjects && (
              <div className="ml-auto text-[10px] opacity-60">
                {plotterObjects.objects.length} object{plotterObjects.objects.length === 1 ? "" : "s"} on layer
              </div>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {emptyMessage ? (
            <div className="text-xs opacity-60 py-3">{emptyMessage}</div>
          ) : (
            // Three columns: 3D view (orbit-controllable mesh of part
            // bounding boxes + chamber + layer plane), 2D view (per-object
            // outlines on the current layer), parts list. All three share
            // the same selectedId/hoveredId state so picking happens
            // anywhere.
            // 3-column responsive grid matching CameraPanel's breakpoints,
            // so the 3D and 2D tiles render at the same width as the chamber
            // / thermal / galvo camera tiles. On md the parts list spans both
            // columns under the two tiles; on xl all three sit in one row.
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              <div className="relative border-2 border-border bg-background overflow-hidden aspect-square w-full">
                <BuildLayout3D
                  chamber={effectiveChamber}
                  printingObjects={objects}
                  layerZ={layerZ}
                  selectedId={selectedId}
                  hoveredId={hoveredId}
                  onSelect={setSelectedId}
                  onHover={setHoveredId}
                />
              </div>
              <div className="relative border-2 border-border bg-background overflow-hidden aspect-square w-full">
                <BuildLayoutSvg
                  plotterObjects={plotterObjects}
                  selectedId={selectedId}
                  hoveredId={hoveredId}
                  onSelect={setSelectedId}
                  onHover={setHoveredId}
                />
              </div>
              {/* Parts list: pinned-bottom action button (always visible),
                  scrollable list above it. On xl the list cell auto-stretches
                  to match the square tile height; on md it spans both columns
                  below the tiles, capped so it can still scroll. */}
              <div className="md:col-span-2 xl:col-span-1 flex flex-col gap-3 min-h-0 max-h-[480px] xl:max-h-none">
                <div className="flex-1 min-h-0 overflow-auto pr-1 flex flex-col gap-1">
                  {[...groups.entries()].map(([name, group]) => (
                    <div key={name} className="flex flex-col gap-0.5">
                      <GroupHeading
                        name={name}
                        count={group.length}
                        excludedCount={group.filter((o) => o.isExcluded).length}
                      />
                      {group.map((obj) => (
                        <ObjectRow
                          key={obj.id}
                          obj={obj}
                          selected={obj.id === selectedId}
                          hovered={obj.id === hoveredId}
                          onSelect={() => setSelectedId(obj.id)}
                          onHover={(h) => setHoveredId(h ? obj.id : null)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <div>
                  {selected ? (
                    <Button
                      variant="default"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        setPendingError(null);
                        setPending({ obj: selected, action: selected.isExcluded ? "include" : "exclude" });
                      }}
                    >
                      {selected.isExcluded ? (
                        <>
                          <RotateCcw className="size-3.5 mr-1" /> Include back in print
                        </>
                      ) : (
                        <>
                          <Scissors className="size-3.5 mr-1" /> Exclude from print
                        </>
                      )}
                    </Button>
                  ) : (
                    <div className="text-[10px] opacity-50 text-center py-1">
                      Select an object to include or exclude.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {pending && (
        <ConfirmModal
          obj={pending.obj}
          action={pending.action}
          busy={busy}
          error={pendingError}
          onConfirm={onConfirm}
          onCancel={() => {
            if (busy) return;
            setPending(null);
            setPendingError(null);
          }}
        />
      )}
    </>
  );
}
