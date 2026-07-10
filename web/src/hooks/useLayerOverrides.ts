import { useCallback, useEffect, useState } from "react";

// Generic LayerClientOptions runtime overrides (speeds, shake, powder dosing,
// Z clearance, delays). The field list — names, kinds, ranges — comes from
// the plugin's registry, so new firmware knobs appear here without a UI
// contract change. `savedState` is the plugin-held override (null = deferring
// to config/profile); `iOptionsMonitor` is the value the print pipeline
// currently sees (includes config-pinned values). TimeSpan knobs are
// fractional seconds. `available` mirrors useRecoaterPassesFull's 404
// detection for older deployed plugin builds.
export interface LayerOverrideField {
  name: string;
  kind: "int" | "double" | "seconds";
  min: number;
  max: number;
  iOptions: number | null;
  iOptionsMonitor: number | null;
  savedState: number | null;
  // The running print profile's value for this knob (converted to override
  // units plugin-side, e.g. profile percent → factor) — the effective value
  // while no override is set. Null when idle or the knob is config-only.
  profileValue: number | null;
}

export interface LayerOverridesState {
  fields: LayerOverrideField[];
  available: boolean | null;
  setFields: (values: Record<string, number | null>) => Promise<void>;
  busy: boolean;
  error: string | null;
}

interface Envelope {
  data?: { fields: LayerOverrideField[] };
}

export function useLayerOverrides(intervalMs = 5000): LayerOverridesState {
  const [fields, setFieldsState] = useState<LayerOverrideField[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/printing/layer-overrides");
        if (!r.ok) {
          const payload = (await r.json().catch(() => null)) as { status?: number } | null;
          if (!cancelled && payload?.status === 404) setAvailable(false);
          return;
        }
        const env = (await r.json()) as Envelope;
        if (cancelled || !env.data) return;
        setFieldsState(env.data.fields ?? []);
        setAvailable(true);
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

  const setFields = useCallback(async (values: Record<string, number | null>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/printing/layer-overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!r.ok) {
        const errPayload = await r.json().catch(() => ({}));
        throw new Error((errPayload as { error?: string })?.error ?? `HTTP ${r.status}`);
      }
      const env = (await r.json()) as Envelope;
      if (env.data) setFieldsState(env.data.fields ?? []);
    } catch (e) {
      setError((e as Error).message ?? String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  return { fields, available, setFields, busy, error };
}
