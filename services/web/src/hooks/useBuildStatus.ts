import { useEffect, useState } from "react";

// Per-build dataset artifact existence, from the tasks service
// (GET /api/tasks/build-status?builds=…). Drives the "already exported?" readout.
export interface BuildArtifacts {
  telemetry: boolean;
  position: boolean;
  labels: boolean;
  frames: boolean;
  frames_index: boolean;
  ticks: boolean;
  peregrine: boolean;
}

export function useBuildStatus(buildIds: number[], intervalMs = 15000): Record<number, BuildArtifacts> {
  // stable key so the effect only re-runs when the id set actually changes
  const key = [...new Set(buildIds)].sort((a, b) => a - b).join(",");
  const [map, setMap] = useState<Record<number, BuildArtifacts>>({});

  useEffect(() => {
    if (!key) { setMap({}); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/tasks/build-status?builds=${key}`);
        if (!r.ok) return;
        const d = (await r.json()) as Record<string, BuildArtifacts>;
        if (!cancelled) {
          setMap(Object.fromEntries(Object.entries(d).map(([k, v]) => [Number(k), v])));
        }
      } catch {
        /* transient / tasks service down — leave prior state */
      }
    };
    void load();
    const id = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [key, intervalMs]);

  return map;
}
