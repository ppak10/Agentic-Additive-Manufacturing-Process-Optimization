import { useMemo, useState } from "react";
import { Scissors, RotateCcw, AlertTriangle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePrintingObjects, excludePrintingObject, type PrintingObject } from "@/hooks/usePrintingObjects";
import { usePlotterVersion } from "@/hooks/usePlotterVersion";

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
  onSelect,
}: {
  obj: PrintingObject;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 px-2 py-1 rounded-base border-2 cursor-pointer transition-all",
        selected ? "border-border bg-main/20" : "border-transparent hover:border-border hover:bg-secondary-background",
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

export function BuildLayoutPanel() {
  const { objects, unavailable, refresh } = usePrintingObjects(2000);
  const plotter = usePlotterVersion(1000);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
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
    <div className="p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>Build layout</span>
            {plotter && objects && objects.length > 0 && (
              <span className="opacity-60 font-base text-[11px]">
                · layer {plotter.currentLayer} / {plotter.layerCount}
              </span>
            )}
            {objects && objects.length > 0 && (
              <Badge variant={excludedCount > 0 ? "default" : "neutral"} className="ml-1">
                {totalCount} objects{excludedCount > 0 && ` · ${excludedCount} excluded`}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-2 text-[10px]">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overlayEnabled}
                  onChange={(e) => setOverlayEnabled(e.target.checked)}
                  className="size-3"
                />
                <span className="opacity-70">layer overlay</span>
              </label>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {emptyMessage ? (
            <div className="text-xs opacity-60 py-3">{emptyMessage}</div>
          ) : (
            <div className="grid md:grid-cols-[1fr_280px] gap-4">
              <div className="relative border-2 border-border bg-background overflow-hidden">
                {/* Base layer slice from the firmware's plotted-image endpoint
                    (already proxied via /api/camera/galvo.png). Cache-busted
                    by plotter version so refetches happen only on real change. */}
                <img
                  src={`/api/camera/galvo.png?v=${plotter?.version ?? 0}`}
                  alt="layer slice"
                  className="block w-full object-contain"
                />
                {overlayEnabled && selected && plotter && (
                  <img
                    src={`/api/plotter/objects/${selected.id}/mask.png?on=ff3030cc&off=00000000&v=${plotter.version}`}
                    alt={`mask for object ${selected.id}`}
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none mix-blend-screen"
                    // 404 happens when the selected object hasn't been emitted
                    // on the current layer yet — silently hide rather than
                    // showing a broken-image icon.
                    onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")}
                    onLoad={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "visible")}
                  />
                )}
              </div>
              <div className="flex flex-col gap-1 max-h-[60vh] overflow-auto pr-1">
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
                        onSelect={() => setSelectedId(obj.id)}
                      />
                    ))}
                  </div>
                ))}
                <div className="mt-auto pt-3">
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
    </div>
  );
}
