import { useCallback, useEffect, useState } from "react";

// The firmware's native mid-print tuning channel
// (IPrintingService.SetupOverrides): phase temperature targets [°C], total
// laser energy percent, fill energy density, outline energy densities.
// The firmware resets these to empty at every print start, so they're only
// meaningful during a print. `defaults` is the running profile's baseline
// (SetupOverridesDefaults) for placeholders; empty when idle. `available`
// mirrors the other hooks' 404 detection for older deployed plugin builds.
export interface SetupOverridesState {
  values: Record<string, number | null>;
  defaults: Record<string, number | null>;
  outlineEnergyDensities: number[] | null;
  defaultOutlineEnergyDensities: number[] | null;
  available: boolean | null;
  setFields: (values: Record<string, number | number[] | null>) => Promise<void>;
  busy: boolean;
  error: string | null;
}

interface Envelope {
  data?: {
    values: Record<string, number | null>;
    defaults: Record<string, number | null>;
    outlineEnergyDensities: number[] | null;
    defaultOutlineEnergyDensities: number[] | null;
  };
}

export function useSetupOverrides(intervalMs = 5000): SetupOverridesState {
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [defaults, setDefaults] = useState<Record<string, number | null>>({});
  const [outlineEnergyDensities, setOutline] = useState<number[] | null>(null);
  const [defaultOutlineEnergyDensities, setDefaultOutline] = useState<number[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyEnvelope = useCallback((env: Envelope) => {
    if (!env.data) return;
    setValues(env.data.values ?? {});
    setDefaults(env.data.defaults ?? {});
    setOutline(env.data.outlineEnergyDensities ?? null);
    setDefaultOutline(env.data.defaultOutlineEnergyDensities ?? null);
    setAvailable(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/printing/setup-overrides");
        if (!r.ok) {
          const payload = (await r.json().catch(() => null)) as { status?: number } | null;
          if (!cancelled && payload?.status === 404) setAvailable(false);
          return;
        }
        const env = (await r.json()) as Envelope;
        if (!cancelled) applyEnvelope(env);
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
  }, [intervalMs, applyEnvelope]);

  const setFields = useCallback(
    async (next: Record<string, number | number[] | null>) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch("/api/printing/setup-overrides", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: next }),
        });
        if (!r.ok) {
          const errPayload = await r.json().catch(() => ({}));
          throw new Error((errPayload as { error?: string })?.error ?? `HTTP ${r.status}`);
        }
        applyEnvelope((await r.json()) as Envelope);
      } catch (e) {
        setError((e as Error).message ?? String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [applyEnvelope],
  );

  return {
    values,
    defaults,
    outlineEnergyDensities,
    defaultOutlineEnergyDensities,
    available,
    setFields,
    busy,
    error,
  };
}
