import { useEffect, useState } from "react";

export interface JobStatus {
  phase: string | null;
  jobName: string | null;
  progress: number;
  remaining: string;
  remainingIncomplete: boolean;
  phaseDone: number | null;
  phaseTotal: number | null;
  printProfileName: string | null;
  surfaceTarget: number | null;
  cpuTemp: number;
  gpuTemp: number;
  totalCpuLoad: number;
  selfCpuLoad: number;
  selfUsedMemory: number;
  totalUsedMemory: number;
  totalAvailableMemory: number;
  movementDuration: string;
  movementTotalDuration: string;
  movementHasXYL: boolean;
}

export function useJob(intervalMs = 1000): JobStatus | null {
  const [status, setStatus] = useState<JobStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/job/current");
        if (!r.ok) return;
        const data = (await r.json()) as JobStatus | null;
        if (!cancelled) setStatus(data);
      } catch {
        /* swallow */
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return status;
}
