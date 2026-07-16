import { useEffect, useState } from "react";

export interface SpoolFrame {
  tsMs: number;
  path: string;
}

export interface SpoolManifest {
  build: {
    id: number;
    job_name: string | null;
    phase: string | null;
    started_at: string;
    ended_at: string | null;
  };
  framesByKind: Record<string, SpoolFrame[]>;
}

// Live playback source for the in-progress build. Polls so newly-recorded frames
// appear over time. Read from the NVMe spool, not the DB (frame rows don't exist
// until the post-print import).
export function useSpoolManifest(
  buildId: number,
  pollMs = 1500,
): { manifest: SpoolManifest | null; error: string | null } {
  const [manifest, setManifest] = useState<SpoolManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setError(null);
    const load = async () => {
      try {
        const r = await fetch(`/api/builds/${buildId}/spool-manifest`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as SpoolManifest;
        if (!cancelled) {
          setManifest(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [buildId, pollMs]);

  return { manifest, error };
}
