import { useEffect, useState } from "react";

// Per-object outline polygons for the current layer, as emitted by the
// plugin's ICodePlotter.GetMarkedObjects(). Coordinates are NORMALIZED to
// [0..1] over the plotter raster (the underlying field is named
// `RelativeOutline` in the closed-source plotter) — callers must scale by
// width/height (from /api/plotter/info) to put them in a pixel viewBox.
export interface PlotterObject {
  id: number;
  outline: number[][]; // [[x, y], ...] where x,y ∈ [0, 1]
}

export interface PlotterObjectsState {
  version: number;
  width: number;
  height: number;
  objects: PlotterObject[];
}

interface Envelope {
  data?: PlotterObjectsState;
}

// Polls /api/plotter/objects. State only updates when `version` bumps so a
// stable layer doesn't trigger unnecessary re-renders (a layer with many
// small parts has hundreds of polygon points — cheap to draw, but cheap to
// skip is cheaper).
export function usePlotterObjects(intervalMs = 1000): PlotterObjectsState | null {
  const [data, setData] = useState<PlotterObjectsState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/plotter/objects");
        if (!r.ok) return;
        const env = (await r.json()) as Envelope;
        if (cancelled || !env.data) return;
        setData((prev) => (prev?.version === env.data!.version ? prev : env.data!));
      } catch {
        /* swallow — server-side circuit breaker handles steady-state outage */
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return data;
}
