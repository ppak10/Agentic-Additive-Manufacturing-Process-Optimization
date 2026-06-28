import { useCallback, useEffect, useState } from "react";

// Per-print object state — name, mesh hash, transform, isExcluded — sourced
// from the plugin's IPrintingService.GetPrintingObjectStates(). Object IDs
// are int and match CodePlotterMarkedObject.Id, so the same id keys both
// /api/printing/objects/{id}/exclude and /api/plotter/objects/{id}/mask.png.
export interface PrintingObject {
  id: number;
  name: string;
  hash: string | null;
  transform: number[][]; // 4x4 row-major
  isExcluded: boolean;
}

export interface PrintingObjectsState {
  // null until first response; empty array means upstream responded with no
  // active print. distinguishing these in the UI matters: loading vs. idle.
  objects: PrintingObject[] | null;
  // populated when the recorder returns 502 (plugin unreachable or older
  // plugin without the /printing/objects route deployed).
  unavailable: boolean;
  refresh: () => void;
}

interface Envelope {
  respondedAt?: string;
  data?: { objects?: PrintingObject[] };
}

export function usePrintingObjects(intervalMs = 2000): PrintingObjectsState {
  const [objects, setObjects] = useState<PrintingObject[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/printing/objects");
        if (cancelled) return;
        if (r.status === 404 || r.status === 502) {
          setUnavailable(true);
          return;
        }
        if (!r.ok) return;
        const env = (await r.json()) as Envelope;
        if (cancelled) return;
        setUnavailable(false);
        setObjects(env.data?.objects ?? []);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    };
    void fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, tick]);

  return { objects, unavailable, refresh };
}

// Posts the include/exclude toggle and returns the firmware-confirmed state
// (firmware is the source of truth; phases where exclusion is a no-op return
// the unchanged value). Throws on transport failure so the caller can surface
// it in the modal UI.
export async function excludePrintingObject(id: number, excluded: boolean): Promise<{ id: number; isExcluded: boolean }> {
  const r = await fetch(`/api/printing/objects/${id}/exclude`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excluded }),
  });
  if (!r.ok) throw new Error(`exclude failed: ${r.status}`);
  const env = (await r.json()) as { data?: { id: number; isExcluded: boolean } };
  if (!env.data) throw new Error("exclude: missing data in response");
  return env.data;
}
