import { useEffect, useState } from "react";

// Lightweight "is the printer currently printing?" poll. Reads the firmware
// flag from the recorder health endpoint, but WITHOUT useRecordingHealth's
// document.title / desktop-notification side effects — that hook is meant to
// run exactly once (the status banner), so re-using it elsewhere would thrash
// the title and double-fire alerts. Used to decide whether to surface the
// live chamber feed as a conversation artifact.
export function useIsPrinting(intervalMs = 3000): boolean {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/health/recording");
        if (!r.ok) return;
        const d = (await r.json()) as { firmware?: { is_printing?: boolean } };
        if (!cancelled) setPrinting(d?.firmware?.is_printing === true);
      } catch {
        /* leave the last known value; a blip shouldn't flap the panel */
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return printing;
}
