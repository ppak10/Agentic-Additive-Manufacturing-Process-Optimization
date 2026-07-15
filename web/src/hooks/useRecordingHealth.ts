import { useEffect, useRef, useState } from "react";

export type RecordingState =
  | "RECORDING"
  | "IDLE"
  | "PRINTING_NOT_RECORDING"
  | "PRINTER_UNREACHABLE"
  | "STARTING_UP";

export type SpoolStream = "telemetry" | "position" | "frames";

export interface SpoolStreamHealth {
  frame_lag_ms: number | null;
  append_lag_ms: number | null;
  lines: number;
  last_error: { at_ms: number; message: string } | null;
}

export interface RecordingHealth {
  overall: RecordingState;
  reason: string;
  timestamp_ms: number;
  firmware: {
    reachable: boolean;
    phase: string | null;
    is_printing: boolean;
    error?: string;
  };
  build: {
    current_build_id: number | null;
  };
  // Print-time recording is measured against the NVMe spool (in-memory on the
  // server), not the DB — Postgres only receives the data after the build ends.
  spool: Record<SpoolStream, SpoolStreamHealth>;
  importer: { buildId: number; stream: SpoolStream; rowsInserted: number } | null;
  budgets: {
    telemetry_max_lag_ms: number;
  };
}

// Client-side deadman. If the endpoint itself hasn't answered in this long,
// treat as offline regardless of what the last cached value said. Fail-closed:
// silence is not consent, silence is a broken endpoint.
const CLIENT_DEADMAN_MS = 10_000;

export type ClientRecordingState = RecordingState | "ENDPOINT_UNREACHABLE";

const BAD_STATES: readonly ClientRecordingState[] = [
  "PRINTING_NOT_RECORDING",
  "PRINTER_UNREACHABLE",
  "ENDPOINT_UNREACHABLE",
];

export function useRecordingHealth(intervalMs = 2_000): {
  health: RecordingHealth | null;
  clientState: ClientRecordingState;
} {
  const [health, setHealth] = useState<RecordingHealth | null>(null);
  // Default state is "ENDPOINT_UNREACHABLE" — fail-closed until proven healthy.
  const [clientState, setClientState] = useState<ClientRecordingState>("ENDPOINT_UNREACHABLE");
  const lastSuccessAtRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/health/recording");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as RecordingHealth;
        if (cancelled) return;
        lastSuccessAtRef.current = Date.now();
        setHealth(data);
        setClientState(data.overall);
      } catch {
        if (cancelled) return;
        if (Date.now() - lastSuccessAtRef.current > CLIENT_DEADMAN_MS) {
          setClientState("ENDPOINT_UNREACHABLE");
        }
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  // Tab title reflects state — visible even when the tab is backgrounded.
  useEffect(() => {
    const base = "Agentic SLS · Inova MK1";
    let title = base;
    switch (clientState) {
      case "PRINTING_NOT_RECORDING":
        title = `🔴 NOT RECORDING — ${base}`;
        break;
      case "PRINTER_UNREACHABLE":
        title = `⚠️ PRINTER UNREACHABLE — ${base}`;
        break;
      case "ENDPOINT_UNREACHABLE":
        title = `⚠️ RECORDER OFFLINE — ${base}`;
        break;
      case "RECORDING":
        title = `🟢 REC — ${base}`;
        break;
    }
    document.title = title;
    return () => {
      document.title = base;
    };
  }, [clientState]);

  // Desktop notification on transition INTO a bad state, so alarms fire even
  // when the browser is minimized. We only fire on the transition — no spam.
  const prevStateRef = useRef<ClientRecordingState>(clientState);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = clientState;
    if (prev === clientState) return;
    const isBad = BAD_STATES.includes(clientState);
    const wasBad = BAD_STATES.includes(prev);
    if (!isBad || wasBad) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification("Inova recorder alert", {
      body: `${clientState}: ${health?.reason ?? "check recorder"}`,
      requireInteraction: clientState === "PRINTING_NOT_RECORDING",
    });
  }, [clientState, health?.reason]);

  return { health, clientState };
}

// Convenience wrapper for the "Enable alerts" button in the banner.
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return await Notification.requestPermission();
}
