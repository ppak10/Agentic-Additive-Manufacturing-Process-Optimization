import { useEffect, useState } from "react";
import type { ChamberSize } from "@/hooks/useChamber";

// Placed instances of a STORED job — the nesting solution persisted in the
// .s4a archive, served by the plugin's /jobs/{id}/instances (works while
// idle, unlike /api/job/current/parts). `transform` is the firmware's
// MeshPrintTransform as a row-major 4x4 in the same V·M convention as
// PrintingObject.transform — feed it to buildWorldMatrix unchanged.
export interface JobInstance {
  id: string;
  name: string | null;
  hash: string;
  isOverlapping: boolean;
  transform: number[][];
}

export interface JobInstancesState {
  chamber: ChamberSize | null;
  // null while loading; [] for jobs that were never nested
  instances: JobInstance[] | null;
  // true when the deployed plugin predates the /jobs/{id}/instances route
  // (404/502) — callers should hide the 3D preview rather than spin forever
  unavailable: boolean;
}

export function useJobInstances(jobId: string | null): JobInstancesState {
  const [state, setState] = useState<JobInstancesState>({
    chamber: null,
    instances: null,
    unavailable: false,
  });

  useEffect(() => {
    if (!jobId) {
      setState({ chamber: null, instances: null, unavailable: false });
      return;
    }
    let cancelled = false;
    setState({ chamber: null, instances: null, unavailable: false });
    void (async () => {
      try {
        const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/instances`);
        if (cancelled) return;
        if (r.status === 404 || r.status === 502) {
          setState((s) => ({ ...s, unavailable: true }));
          return;
        }
        if (!r.ok) return;
        const d = (await r.json()) as {
          chamber?: ChamberSize | null;
          instances?: JobInstance[];
        };
        if (!cancelled) {
          setState({ chamber: d.chamber ?? null, instances: d.instances ?? [], unavailable: false });
        }
      } catch {
        if (!cancelled) setState((s) => ({ ...s, unavailable: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return state;
}
