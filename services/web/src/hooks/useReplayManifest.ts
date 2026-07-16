import { useEffect, useState } from "react";

export interface FrameSample {
  id: number;
  tsMs: number;
}

export interface ReplayEvent {
  id: number;
  ts: string;
  kind: string;
  message: string | null;
  payload: unknown;
}

export interface ReplayBuild {
  id: number;
  job_name: string | null;
  phase: string | null;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
  params: Record<string, unknown> | null;
}

export interface ReplayManifest {
  build: ReplayBuild;
  events: ReplayEvent[];
  framesByKind: Record<string, FrameSample[]>;
}

export function useReplayManifest(buildId: number): {
  manifest: ReplayManifest | null;
  error: string | null;
} {
  const [manifest, setManifest] = useState<ReplayManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setError(null);
    (async () => {
      try {
        const r = await fetch(`/api/builds/${buildId}/manifest`);
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const data = (await r.json()) as ReplayManifest;
        if (!cancelled) setManifest(data);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildId]);

  return { manifest, error };
}

// Binary search for the largest tsMs <= playheadMs. Returns the frame id, or null
// if no sample exists before the playhead (e.g., scrubbing before the first frame).
export function findNearestFrame(samples: FrameSample[] | undefined, playheadMs: number): number | null {
  if (!samples || samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  if (samples[0]!.tsMs > playheadMs) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid]!.tsMs <= playheadMs) lo = mid;
    else hi = mid - 1;
  }
  return samples[lo]!.id;
}
