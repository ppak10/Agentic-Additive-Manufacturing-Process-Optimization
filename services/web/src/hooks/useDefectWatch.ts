import { useEffect, useRef, useState } from "react";

export type DefectVerdict = "correct" | "ignored" | "incorrect";

// One connected region of a class's anomaly map (map-space normalized
// 0..1 = the full chamber frame). key is stable per map so submitted
// verdicts survive poll refreshes.
export type DefectBlob = {
  key: string;
  class: string;
  bbox: [number, number, number, number];
  centroid: [number, number];
  area_px: number;
  peak: number;
};

// Polls the defect bridge (services/defect, :3200 via the /defect proxy).
// Notify-only: this surfaces the model's per-layer verdicts in the
// attention bar; it never drives printer actions.

export type DefectLatest = {
  buildId: number | null;
  layer: number;
  ts: string;
  eventId: number | null;
  // verdicts already submitted for this event (cls → DefectVerdict)
  feedback: Record<string, string>;
  result: {
    scores: Record<string, number>;
    alerts: string[]; // class names over threshold
    // Per-class anomaly maps (grayscale b64 PNGs at the model's logits
    // resolution, spanning the FULL chamber frame) — the server includes
    // maps only for alerted classes.
    maps_png?: Record<string, string>;
    latency_ms?: number;
  };
} | null;

export type DefectBridgeHealth = {
  status: string;
  model_reachable: boolean | null;
  last_error: string | null;
} | null;

export function useDefectWatch(intervalMs = 5_000) {
  const [latest, setLatest] = useState<DefectLatest>(null);
  const [bridge, setBridge] = useState<DefectBridgeHealth>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [l, h] = await Promise.all([
          fetch("/defect/latest").then((r) => r.json()),
          fetch("/defect/health").then((r) => r.json()),
        ]);
        if (!cancelled) {
          setLatest(l);
          setBridge(h);
        }
      } catch {
        if (!cancelled) setBridge(null); // bridge down/unreachable
      }
    };
    void tick();
    timer.current = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [intervalMs]);

  const alerted = latest?.result.alerts ?? [];

  // Human-loop label channel, three-state: correct (real), ignored
  // (seen but not acted on — neither label), incorrect (clean negative).
  // Pass a blob to scope the verdict to one map region instead of the
  // whole frame (keyed by blob.key in the feedback map). Fire-and-forget
  // with an optimistic local echo — the next poll re-syncs from the
  // bridge's authoritative copy.
  const sendFeedback = async (
    eventId: number,
    cls: string,
    verdict: DefectVerdict,
    blob?: DefectBlob,
  ) => {
    const feedbackKey = blob?.key ?? cls;
    setLatest((l) =>
      l && l.eventId === eventId
        ? { ...l, feedback: { ...l.feedback, [feedbackKey]: verdict } }
        : l,
    );
    try {
      await fetch("/defect/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_id: eventId, verdicts: { [cls]: verdict }, blob }),
      });
    } catch {
      /* next poll restores true state */
    }
  };

  return { latest, bridge, alerted, sendFeedback };
}
