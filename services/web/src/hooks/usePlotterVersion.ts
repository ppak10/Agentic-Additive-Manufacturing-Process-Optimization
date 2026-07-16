import { useEffect, useState } from "react";

// Polls the plugin's /plotter/info for its monotonic version + currentLayer.
// Used by the build-layout overlay to cache-bust the per-object mask image
// only when the plotter actually has new data — avoids hammering the printer
// with mask refetches every poll tick.
export interface PlotterVersion {
  version: number;
  currentLayer: number;
  layerCount: number;
  width: number;
  height: number;
}

interface Envelope {
  data?: PlotterVersion;
}

export function usePlotterVersion(intervalMs = 1000): PlotterVersion | null {
  const [info, setInfo] = useState<PlotterVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/plotter/info");
        if (!r.ok) return;
        const env = (await r.json()) as Envelope;
        if (!cancelled && env.data) setInfo(env.data);
      } catch {
        /* swallow — circuit breaker on server side handles steady-state outage */
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return info;
}
