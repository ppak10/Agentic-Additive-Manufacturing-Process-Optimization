import { useCallback, useEffect, useState } from "react";

// Runtime full-recoat passes override. Unlike useRecoaterPasses (the
// firmware's staged powder delivery within one recoat sequence), this drives
// the plugin's FullRecoatLayerClient substitution: each print layer is
// expanded into N full-height recoats — one normal recoat plus N-1 repeat
// sweeps at the same bed height. `powder` controls whether the repeat sweeps
// each feed a fresh full powder dose (short-feed compensation) or run dry
// (debris clearing). Applied on the next LayerClient.BeginLayer.
// `replacementActive` reports whether the LayerClient substitution is
// actually loaded on the printer — the override is a no-op when false (e.g.
// plugin deployed without the replacement entry, or an older plugin build
// without the endpoint).
export interface RecoaterPassesFullState {
  value: number | null;
  powder: boolean;
  replacementActive: boolean | null;
  setValue: (n: number | null, powder?: boolean) => Promise<void>;
  busy: boolean;
  error: string | null;
}

interface Envelope {
  data?: {
    value: number | null;
    powder: boolean;
    replacementActive: boolean;
    layerClientType: string | null;
  };
}

export function useRecoaterPassesFull(intervalMs = 5000): RecoaterPassesFullState {
  const [value, setValueState] = useState<number | null>(null);
  const [powder, setPowderState] = useState<boolean>(true);
  const [replacementActive, setReplacementActive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/printing/recoater-passes-full");
        if (!r.ok) {
          // The server proxy maps an upstream 404 — a deployed plugin build
          // that predates this endpoint — to 502 {error:"upstream",
          // status:404}. That means the substitution is definitively absent,
          // not a transient failure: mark unavailable so the input disables.
          const payload = (await r.json().catch(() => null)) as { status?: number } | null;
          if (!cancelled && payload?.status === 404) setReplacementActive(false);
          return;
        }
        const env = (await r.json()) as Envelope;
        if (cancelled || !env.data) return;
        setValueState(env.data.value ?? null);
        setPowderState(env.data.powder ?? true);
        setReplacementActive(env.data.replacementActive ?? null);
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
  }, [intervalMs]);

  const setValue = useCallback(async (n: number | null, powderArg?: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/printing/recoater-passes-full", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: n, powder: powderArg }),
      });
      if (!r.ok) {
        const errPayload = await r.json().catch(() => ({}));
        throw new Error((errPayload as { error?: string })?.error ?? `HTTP ${r.status}`);
      }
      const env = (await r.json()) as Envelope;
      if (env.data) {
        setValueState(env.data.value ?? null);
        setPowderState(env.data.powder ?? true);
        setReplacementActive(env.data.replacementActive ?? null);
      }
    } catch (e) {
      setError((e as Error).message ?? String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  return { value, powder, replacementActive, setValue, busy, error };
}
