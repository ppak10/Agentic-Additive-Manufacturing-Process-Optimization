import { useEffect, useState } from "react";

export interface PluginInfo {
  plugin: string;
  version: string;
  listenPort: number;
  startedAtUtc: string;
  uptimeSeconds: number;
}

export function usePluginInfo(intervalMs = 30000): PluginInfo | null {
  const [info, setInfo] = useState<PluginInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/info");
        if (!r.ok) return;
        const data = (await r.json()) as PluginInfo;
        if (!cancelled) setInfo(data);
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

  return info;
}

export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
