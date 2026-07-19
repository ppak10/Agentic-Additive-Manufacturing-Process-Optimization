import { useEffect, useState } from "react";

// The currently-printing build (id + is-printing), from the recorder health
// endpoint's current_build_id. Lets a build artifact decide whether to show the
// LIVE build-mission-control stream (this build IS the active print) or a static
// recorded summary (a past build). Same lightweight poll as useIsPrinting, with
// no title/notification side effects.
export interface ActiveBuild {
  printing: boolean;
  buildId: number | null;
}

export function useActiveBuild(intervalMs = 3000): ActiveBuild {
  const [state, setState] = useState<ActiveBuild>({ printing: false, buildId: null });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/health/recording");
        if (!r.ok) return;
        const d = (await r.json()) as {
          firmware?: { is_printing?: boolean };
          build?: { current_build_id?: number | string | null };
        };
        if (!cancelled) {
          const raw = d?.build?.current_build_id;
          setState({
            printing: d?.firmware?.is_printing === true,
            buildId: raw != null ? Number(raw) : null,
          });
        }
      } catch {
        /* keep last known — a blip shouldn't flap the panel */
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}
