import { useEffect, useRef, useState } from "react";
import type { RecordingHealth } from "@/hooks/useRecordingHealth";
import type { PluginInfo } from "@/hooks/usePluginInfo";

// One poll cycle hits every service's health surface directly, each with its
// own timeout — a hung service must resolve to "down", not stall the page.
// Postgres and the firmware are reported THROUGH the recorder, so their
// status is "unknown" (not "down") when the recorder itself is unreachable.

export interface DbHealth {
  connected: boolean;
  latency_ms: number | null;
  error?: string;
  builds_count: number | null;
  max_build: number | null;
  last_event_ts: string | null;
  has_agent_tables: boolean | null;
  has_build_summaries: boolean | null;
}

export interface BrokerHealth {
  ok: boolean;
  chats: number;
  db: boolean;
}

export interface ServiceProbe<T> {
  status: "up" | "down" | "unknown";
  latencyMs: number | null;
  data: T | null;
  error: string | null;
}

export interface ServicesHealth {
  checkedAt: number;
  recorder: ServiceProbe<RecordingHealth>;
  db: ServiceProbe<DbHealth>;
  broker: ServiceProbe<BrokerHealth>;
  plugin: ServiceProbe<PluginInfo>;
}

const PROBE_TIMEOUT_MS = 3_000;

async function probe<T>(url: string): Promise<ServiceProbe<T>> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) {
      return { status: "down", latencyMs: null, data: null, error: `HTTP ${r.status}` };
    }
    const data = (await r.json()) as T;
    return { status: "up", latencyMs: Date.now() - started, data, error: null };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      status: "down",
      latencyMs: null,
      data: null,
      error: aborted ? `timeout after ${PROBE_TIMEOUT_MS}ms` : String((err as Error)?.message ?? err),
    };
  } finally {
    clearTimeout(t);
  }
}

export function useServicesHealth(intervalMs = 4_000): ServicesHealth | null {
  const [health, setHealth] = useState<ServicesHealth | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (inFlight.current) return; // never stack polls behind slow probes
      inFlight.current = true;
      try {
        const [recorder, db, broker, plugin] = await Promise.all([
          probe<RecordingHealth>("/api/health/recording"),
          probe<DbHealth>("/api/health/db"),
          probe<BrokerHealth>("/agent/health"),
          probe<PluginInfo>("/api/info"),
        ]);
        // /api/health/db and /api/info are served via the recorder; if the
        // recorder is down they say nothing about postgres or the plugin.
        if (recorder.status === "down") {
          db.status = "unknown";
          plugin.status = "unknown";
        }
        if (!cancelled) {
          setHealth({ checkedAt: Date.now(), recorder, db, broker, plugin });
        }
      } finally {
        inFlight.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return health;
}
