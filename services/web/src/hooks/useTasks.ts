import { useCallback, useEffect, useState } from "react";

// Mirrors the `tasks` table row shape returned by the tasks service
// (services/pipeline/agentic_sls/tasks) — snake_case, straight from Postgres.
export interface TaskRow {
  id: number;
  kind: string;
  args: Record<string, unknown>;
  build_id: number | null;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  progress: number | null;
  log: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface UseTasksState {
  list: TaskRow[] | null;
  error: string | null;
  refresh: () => void;
  createTask: (kind: string, args: Record<string, unknown>) => Promise<TaskRow>;
  cancelTask: (id: number) => Promise<void>;
}

async function parseError(r: Response): Promise<string> {
  const body = (await r.json().catch(() => ({}))) as { detail?: unknown };
  return typeof body.detail === "string" ? body.detail : `HTTP ${r.status}`;
}

export function useTasks(intervalMs = 4000): UseTasksState {
  const [list, setList] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/tasks?limit=100");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as TaskRow[];
        if (!cancelled) { setList(data); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    };
    void load();
    const id = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [tick, intervalMs]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const createTask = useCallback(async (kind: string, args: Record<string, unknown>) => {
    const r = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, args }),
    });
    if (!r.ok) throw new Error(await parseError(r));
    const row = (await r.json()) as TaskRow;
    setTick((n) => n + 1);
    return row;
  }, []);

  const cancelTask = useCallback(async (id: number) => {
    const r = await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
    if (!r.ok) throw new Error(await parseError(r));
    setTick((n) => n + 1);
  }, []);

  return { list, error, refresh, createTask, cancelTask };
}
