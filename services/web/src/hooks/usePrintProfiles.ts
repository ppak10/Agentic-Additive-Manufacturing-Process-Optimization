import { useCallback, useEffect, useState } from "react";

export interface ProfileDesc {
  id: string;
  name: string;
  isDefault: boolean;
}

// All print profile fields the UI surfaces. Nullable fields inherit from the
// system Default when null; the server's ?merged=true returns effective values.
// timeSpan fields (delays) are ISO 8601 duration strings e.g. "00:00:05".
export interface PrintProfile {
  id: string;
  name: string | null;
  material: string | null;
  layerThickness: number | null;
  recoaterPasses: number | null;
  recoaterPowderSpeedPercent: number | null;
  recoaterPrintSpeedPercent: number | null;
  // Heating
  heatingTargetPowder: number | null;
  heatingTargetPrint: number | null;
  heatingTargetPrintBed: number | null;
  heatingRate: number | null;
  heatingThreshold: number | null;
  surfaceTarget: number | null;
  // Layer temperatures
  beginLayerTemperatureTarget: number | null;
  beginLayerTemperatureDelay: string | null;
  bedPreparationTemperatureTarget: number | null;
  bedPreparationTemperatureDelay: string | null;
  bedPreparationThickness: number | null;
  printCapTemperatureTarget: number | null;
  printCapTemperatureDelay: string | null;
  printCapThickness: number | null;
  // Laser
  laserOnPercent: number | null;
  totalEnergyDensityPercent: number | null;
  laserFirstOutlineEnergyDensity: number | null;
  laserOtherOutlineEnergyDensity: number | null;
  laserFillEnergyDensity: number | null;
  outlineCount: number | null;
  isFillEnabled: boolean | null;
  // Cooling
  coolingTarget: number | null;
  coolingThreshold1: number | null;
  coolingThreshold2: number | null;
  coolingRate1: number | null;
  coolingRate2: number | null;
  // Catch-all for fields not listed above (passed through on save)
  [key: string]: unknown;
}

export interface UsePrintProfilesState {
  list: ProfileDesc[] | null;
  listError: string | null;
  /** Reload the profile list. */
  refresh: () => void;
  createProfile: (name: string) => Promise<PrintProfile>;
  updateProfile: (id: string, patch: Record<string, unknown>) => Promise<PrintProfile>;
  deleteProfile: (id: string) => Promise<void>;
  fetchProfile: (id: string, merged?: boolean) => Promise<PrintProfile>;
}

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
  const r = await fetch(path, opts);
  return r;
}

export function usePrintProfiles(): UsePrintProfilesState {
  const [list, setList] = useState<ProfileDesc[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await apiFetch("/api/profiles");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as ProfileDesc[];
        if (!cancelled) { setList(data); setListError(null); }
      } catch (e) {
        if (!cancelled) setListError((e as Error).message ?? String(e));
      }
    };
    void load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const fetchProfile = useCallback(async (id: string, merged = false): Promise<PrintProfile> => {
    const qs = merged ? "?merged=true" : "";
    const r = await apiFetch(`/api/profiles/${encodeURIComponent(id)}${qs}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json() as Promise<PrintProfile>;
  }, []);

  const createProfile = useCallback(async (name: string): Promise<PrintProfile> => {
    const r = await apiFetch("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await r.json() as PrintProfile & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    setTick((n) => n + 1);
    return body;
  }, []);

  const updateProfile = useCallback(async (id: string, patch: Record<string, unknown>): Promise<PrintProfile> => {
    const r = await apiFetch(`/api/profiles/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await r.json() as PrintProfile & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    setTick((n) => n + 1);
    return body;
  }, []);

  const deleteProfile = useCallback(async (id: string): Promise<void> => {
    const r = await apiFetch(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    setTick((n) => n + 1);
  }, []);

  return { list, listError, refresh, fetchProfile, createProfile, updateProfile, deleteProfile };
}
