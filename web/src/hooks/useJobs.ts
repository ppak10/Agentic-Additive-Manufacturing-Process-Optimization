import { useCallback, useEffect, useState } from "react";

export interface JobDesc {
  id: string;
  type: string;
  name: string;
  createdAt: string; // ISO date string
}

export interface JobDetail extends JobDesc {
  printProfileId: string | null;
  objectFiles: { id: string; name: string; hash: string }[];
  nestingState: {
    chamberDepth: number | null;
    chamberVolume: number | null;
    sinteredVolume: number | null;
    availableDepth: number | null;
  } | null;
  dryPrintEnabled: boolean;
  needsLaser: boolean;
  previewEnabled: boolean;
}

export interface UseJobsState {
  list: JobDesc[] | null;
  listError: string | null;
  refresh: () => void;
  fetchJob: (id: string) => Promise<JobDetail>;
  updateJob: (id: string, patch: { name?: string; printProfileId?: string | null }) => Promise<JobDetail>;
  deleteJob: (id: string) => Promise<void>;
}

export function useJobs(): UseJobsState {
  const [list, setList] = useState<JobDesc[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/jobs");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as JobDesc[];
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

  const fetchJob = useCallback(async (id: string): Promise<JobDetail> => {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    const body = (await r.json()) as JobDetail & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }, []);

  const updateJob = useCallback(async (
    id: string,
    patch: { name?: string; printProfileId?: string | null },
  ): Promise<JobDetail> => {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: patch.name,
        // send empty string to clear the profile (plugin treats "" → Guid.Empty)
        printProfileId: patch.printProfileId === null ? "" : patch.printProfileId,
      }),
    });
    const body = (await r.json()) as JobDetail & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    setTick((n) => n + 1);
    return body;
  }, []);

  const deleteJob = useCallback(async (id: string): Promise<void> => {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.status === 204) { setTick((n) => n + 1); return; }
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }, []);

  return { list, listError, refresh, fetchJob, updateJob, deleteJob };
}
