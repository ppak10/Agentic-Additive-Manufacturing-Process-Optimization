import { useEffect, useRef, useState } from "react";
import {
  fitPlotterMap,
  fitSinglePair,
  loadMeshTriangles,
  sliceMesh,
  worldBbox,
  type FitPair,
  type PlotterMap,
} from "@/lib/slicer";
import type { PlotterObjectsState } from "@/hooks/usePlotterObjects";
import type { PrintingObject } from "@/hooks/usePrintingObjects";

// Vector cross-sections of the current layer, shared by Mission Control's
// chamber overlay and the Feed's Build Layout 2D pane: slice each placed
// STL with the layer plane client-side (lib/slicer.ts) and return loops in
// NORMALIZED PLOTTER SPACE (0..1, same space as /plotter/objects
// outlines) — each consumer projects/scales into its own view. The
// world-mm → plotter mapping is FITTED live from each object's world bbox
// ↔ plotter outline quad (multi-object least squares; cached last-good
// fit; verified single-object fallback). Recomputed once per layer.

export type LayerSlice = { id: number; loops: [number, number][][] };

export function useLayerSlices(
  plotterObjects: PlotterObjectsState | null,
  printingObjects: PrintingObject[] | null,
  enabled = true,
): LayerSlice[] {
  const [slices, setSlices] = useState<LayerSlice[]>([]);
  const lastKey = useRef("");
  // the mapping is a property of the plotter workspace, constant across a
  // build — keep the last well-determined fit for single-object layers
  const lastGoodFit = useRef<PlotterMap | null>(null);

  useEffect(() => {
    // Slice from the PARTS LIST, not the plot: /plotter/objects only lists
    // a part after its first raster command lands, which made new parts'
    // vectors appear one raster late. The layer plane itself decides which
    // parts show — a part not reaching this Z yields no loops.
    if (!enabled || !printingObjects || printingObjects.length === 0) {
      setSlices([]);
      lastKey.current = "";
      return;
    }
    let cancelled = false;
    void (async () => {
      // layer index from the firmware job status (Layers phase only)
      let layerIdx: number | null = null;
      let phaseKnown = false;
      try {
        const j = await (await fetch("/api/job/current")).json();
        phaseKnown = true;
        if (j?.phase === "Layers" && typeof j.phaseDone === "number") layerIdx = j.phaseDone;
      } catch { /* firmware briefly unreachable — keep current slices */ }
      if (cancelled) return;
      if (layerIdx == null) {
        // KNOWN non-Layers phase (PrintCap, Cooling, idle): there truly are
        // no objects on the "current layer" — clear instead of lingering
        // with the last layer's geometry
        if (phaseKnown) {
          setSlices([]);
          lastKey.current = "";
        }
        return;
      }
      const active = printingObjects.filter((o) => !o.isExcluded && o.bounds && o.hash);
      if (active.length === 0) return;
      // Slice mid-layer: the surface at layerIdx×thickness can graze flat
      // top/bottom faces (degenerate). Layer thickness is the same 0.1 mm
      // placeholder BuildLayoutPanel uses until a profile endpoint exists.
      const LAYER_MM = 0.1;
      const z = Math.max(LAYER_MM / 2, layerIdx * LAYER_MM - LAYER_MM / 2);
      // fit correspondences still come from the plot (they need the plotter
      // outline), so the mapping sharpens as parts appear; slicing itself
      // covers every active part regardless
      const pairs: FitPair[] = [];
      for (const po of plotterObjects?.objects ?? []) {
        const part = active.find((o) => o.id === po.id);
        if (!part || !part.bounds) continue;
        let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
        for (const [u, v] of po.outline) {
          if (u! < u0) u0 = u!;
          if (u! > u1) u1 = u!;
          if (v! < v0) v0 = v!;
          if (v! > v1) v1 = v!;
        }
        pairs.push({
          world: worldBbox(part.transform, part.bounds.center, part.bounds.size),
          plot: { cu: (u0 + u1) / 2, cv: (v0 + v1) / 2, su: u1 - u0, sv: v1 - v0 },
        });
      }
      const ids = active.map((o) => o.id).sort().join(",");
      // pairs.length in the key: recompute when new correspondences land
      // (sharper fit), not on every plot version bump
      const key = `${layerIdx}:${ids}:${pairs.length}`;
      if (key === lastKey.current) return;
      const items = active.map((o) => ({ id: o.id, hash: o.hash!, transform: o.transform }));
      const multiFit = fitPlotterMap(pairs);
      if (multiFit) lastGoodFit.current = multiFit;
      const fit =
        multiFit ?? lastGoodFit.current ?? (pairs[0] ? fitSinglePair(pairs[0]) : null);
      if (!fit || cancelled) return;
      const out: LayerSlice[] = [];
      for (const it of items) {
        const mesh = await loadMeshTriangles(it.hash);
        if (cancelled) return;
        if (!mesh) continue;
        const loops = sliceMesh(mesh, it.transform, z);
        out.push({
          id: it.id,
          loops: loops.map((l) => l.map(([x, y]) => fit.map(x, y))),
        });
      }
      if (!cancelled) {
        setSlices(out);
        lastKey.current = key;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plotterObjects, printingObjects, enabled]);

  return slices;
}
