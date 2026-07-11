import { useCallback, useEffect, useState } from "react";

export interface TuningStatus {
  isActive: boolean;
  mode: string;
  phase: string;
  gridDim: number | null;
  gridMargin: number | null;
  powderDepth: number | null;
  laserOnPercent: number | null;
  totalEnergyDensityPercent: number | null;
  recoaterPasses: number | null;
}

export interface PrintSetupSnapshot {
  laserOnPercent: number;
  totalEnergyDensityPercent: number;
  laserFillEnergyDensity: number;
  laserFirstOutlineEnergyDensity: number;
  laserOtherOutlineEnergyDensity: number;
  laserOutlineEnergyDensities: number[] | null;
  laserFillSpeedXY: number;
  laserOutlineSpeedXY: number;
  outlineCount: number;
  fillPhase: number;
  powderTuningGridDim: number;
  powderTuningGridMargin: number;
  powderTuningDepth: number;
}

export interface PatchResult {
  gridIndex: number;
  usedSetup: PrintSetupSnapshot;
  completedAt: number; // unix ms
}

export interface PrintParams {
  laserOnPercent?: number;
  totalEnergyDensityPercent?: number;
  laserFillEnergyDensity?: number;
  laserFirstOutlineEnergyDensity?: number;
  laserOtherOutlineEnergyDensity?: number;
  laserFillSpeedXY?: number;
  laserOutlineSpeedXY?: number;
  outlineCount?: number;
  fillPhase?: number;
  printNumberEnabled?: boolean;
}

export interface UsePowderTuning {
  status: TuningStatus | null;
  statusError: string | null;
  busy: boolean;
  commandError: string | null;
  patchResults: PatchResult[];       // completed patches (local session state)
  selectedPatch: number | null;
  bedLevel: (opts?: { stepThickness?: number; stepCount?: number; dryPrint?: boolean }) => Promise<void>;
  addLayer: (opts?: { temperatureTarget?: number; temperatureDelaySeconds?: number; sinteredVolumeFactor?: number }) => Promise<void>;
  setSurface: (temperature: number) => Promise<void>;
  selectPatch: (gridIndex: number) => Promise<void>;
  fetchPrintSetup: () => Promise<PrintSetupSnapshot>;
  print: (params?: PrintParams) => Promise<PrintSetupSnapshot | null>;
  stop: () => Promise<void>;
  clearError: () => void;
}

interface Envelope<T> { data: T }

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const env = (await r.json()) as Envelope<T> & { error?: string };
  if (!r.ok) throw new Error((env as { error?: string }).error ?? `HTTP ${r.status}`);
  return (env as Envelope<T>).data;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const env = (await r.json()) as Envelope<T> & { error?: string };
  if (!r.ok) throw new Error((env as { error?: string }).error ?? `HTTP ${r.status}`);
  return (env as Envelope<T>).data;
}

export function usePowderTuning(): UsePowderTuning {
  const [status, setStatus] = useState<TuningStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [patchResults, setPatchResults] = useState<PatchResult[]>([]);
  const [selectedPatch, setSelectedPatch] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await get<TuningStatus>("/api/powder-tuning/status");
        if (!cancelled) { setStatus(data); setStatusError(null); }
      } catch (e) {
        if (!cancelled) setStatusError((e as Error).message);
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setCommandError(null);
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setCommandError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const bedLevel = useCallback((opts?: { stepThickness?: number; stepCount?: number; dryPrint?: boolean }) =>
    run(() => post<{ ok: boolean }>("/api/powder-tuning/bed-level", opts ?? {}).then(() => {})),
  [run]);

  const addLayer = useCallback((opts?: { temperatureTarget?: number; temperatureDelaySeconds?: number; sinteredVolumeFactor?: number }) =>
    run(() => post<{ ok: boolean }>("/api/powder-tuning/layer", opts ?? {}).then(() => {})),
  [run]);

  const setSurface = useCallback((temperature: number) =>
    run(() => post<{ ok: boolean }>("/api/powder-tuning/surface", { temperature }).then(() => {})),
  [run]);

  const selectPatch = useCallback(async (gridIndex: number) => {
    await run(() => post<unknown>("/api/powder-tuning/params", { gridIndex }));
    setSelectedPatch(gridIndex);
  }, [run]);

  const fetchPrintSetup = useCallback(() =>
    run(() => get<PrintSetupSnapshot>("/api/powder-tuning/print/setup")),
  [run]);

  const print = useCallback(async (params?: PrintParams): Promise<PrintSetupSnapshot | null> => {
    const used = await run(() => post<PrintSetupSnapshot>("/api/powder-tuning/print", params ?? {}));
    if (selectedPatch !== null && used) {
      setPatchResults((prev) => {
        const next = prev.filter((r) => r.gridIndex !== selectedPatch);
        return [...next, { gridIndex: selectedPatch, usedSetup: used, completedAt: Date.now() }];
      });
    }
    return used;
  }, [run, selectedPatch]);

  const stop = useCallback(() =>
    run(() => post<{ ok: boolean }>("/api/powder-tuning/stop").then(() => {})),
  [run]);

  const clearError = useCallback(() => setCommandError(null), []);

  return {
    status, statusError, busy, commandError, patchResults, selectedPatch,
    bedLevel, addLayer, setSurface, selectPatch, fetchPrintSetup, print, stop, clearError,
  };
}
