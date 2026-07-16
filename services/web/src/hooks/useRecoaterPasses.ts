import { useCallback, useEffect, useState } from "react";

// Runtime recoater-passes override. `value` is what the print pipeline will
// use (null = defer to the print profile's per-layer setting). Applied on
// the next LayerClient.BeginLayer, so a change is visible on the following
// print layer — not the current one.
//
// The plugin's response includes BOTH IOptions.Value and IOptionsMonitor
// snapshots (they resolve to distinct instances in this firmware). The hook
// collapses them to the first non-null — they should always agree because
// the plugin writes them in lock-step. `profileDefault` is what LayerClient
// falls back to when no override is set (from IPrintingService.RunningSetup);
// null when no print is running.
export interface RecoaterPassesState {
  value: number | null;
  profileDefault: number | null;
  savedState: number | null;
  refresh: () => void;
  setValue: (n: number | null) => Promise<void>;
  busy: boolean;
  error: string | null;
}

interface Envelope {
  data?: {
    iOptions: number | null;
    iOptionsMonitor: number | null;
    savedState: number | null;
    profileDefault: number | null;
  };
}

export function useRecoaterPasses(intervalMs = 5000): RecoaterPassesState {
  const [value, setValueState] = useState<number | null>(null);
  const [profileDefault, setProfileDefault] = useState<number | null>(null);
  const [savedState, setSavedState] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/printing/recoater-passes");
        if (!r.ok) return;
        const env = (await r.json()) as Envelope;
        if (cancelled || !env.data) return;
        setValueState(env.data.iOptions ?? env.data.iOptionsMonitor ?? null);
        setProfileDefault(env.data.profileDefault ?? null);
        setSavedState(env.data.savedState);
      } catch {
        /* swallow */
      }
    };
    void fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const setValue = useCallback(async (n: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/printing/recoater-passes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: n }),
      });
      if (!r.ok) {
        const errPayload = await r.json().catch(() => ({}));
        throw new Error((errPayload as { error?: string })?.error ?? `HTTP ${r.status}`);
      }
      const env = (await r.json()) as Envelope;
      if (env.data) {
        setValueState(env.data.iOptions ?? env.data.iOptionsMonitor ?? null);
        setProfileDefault(env.data.profileDefault ?? null);
        setSavedState(env.data.savedState);
      }
    } catch (e) {
      setError((e as Error).message ?? String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  return { value, profileDefault, savedState, refresh, setValue, busy, error };
}
