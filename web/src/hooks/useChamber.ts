import { useEffect, useState } from "react";

// Chamber dimensions from /api/job/current/parts. Mostly static across a
// session (printer hardware doesn't change) but we still poll so the 3D
// view picks up the values once they're available — the chamber block in
// the response is always populated, even when `instances` is empty during
// an active print.
export interface ChamberSize {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

interface Envelope {
  data?: { chamber: ChamberSize | null };
}

export function useChamber(intervalMs = 10000): ChamberSize | null {
  const [chamber, setChamber] = useState<ChamberSize | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/job/current/parts");
        if (!r.ok) return;
        const env = (await r.json()) as Envelope;
        if (cancelled || !env.data?.chamber) return;
        setChamber((prev) =>
          prev?.sizeX === env.data!.chamber!.sizeX &&
          prev?.sizeY === env.data!.chamber!.sizeY &&
          prev?.sizeZ === env.data!.chamber!.sizeZ
            ? prev
            : env.data!.chamber,
        );
      } catch {
        /* swallow */
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return chamber;
}
