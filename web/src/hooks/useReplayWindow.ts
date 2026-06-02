import { useEffect, useRef, useState } from "react";

export interface TelemetryRow {
  ts: string;
  sensor_id: string;
  kind: string;
  value: number;
}

// Returns: rows around the playhead. Debounces playhead changes so scrubbing
// doesn't issue a fetch per pixel. Refetches only when the playhead moves
// outside the previously-loaded window.
export function useReplayWindow(
  buildId: number,
  playheadMs: number,
  kinds: string[],
  windowSec = 30,
): TelemetryRow[] {
  const [rows, setRows] = useState<TelemetryRow[]>([]);
  const loadedRange = useRef<{ fromMs: number; toMs: number } | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const halfWindow = windowSec * 1000;
    const range = loadedRange.current;
    const inRange = range && playheadMs >= range.fromMs + 1000 && playheadMs <= range.toMs - 1000;
    if (inRange) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const fromMs = playheadMs - halfWindow;
      const toMs = playheadMs + halfWindow * 0.5;
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;

      const qs = new URLSearchParams({
        fromMs: String(fromMs),
        toMs: String(toMs),
        kinds: kinds.join(","),
        limit: "20000",
      });
      fetch(`/api/builds/${buildId}/telemetry?${qs.toString()}`, { signal: ac.signal })
        .then((r) => r.json() as Promise<TelemetryRow[]>)
        .then((data) => {
          loadedRange.current = { fromMs, toMs };
          setRows(data);
        })
        .catch((e) => {
          if ((e as { name?: string }).name !== "AbortError") {
            console.error("replay window fetch failed", e);
          }
        });
    }, 150);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [buildId, playheadMs, kinds.join(","), windowSec]);

  return rows;
}

// Pick the most recent value at-or-before playheadMs for each (kind, sensor_id).
export function latestPerSensor(
  rows: TelemetryRow[],
  playheadMs: number,
): Map<string, TelemetryRow> {
  const out = new Map<string, TelemetryRow>();
  for (const r of rows) {
    const ts = new Date(r.ts).getTime();
    if (ts > playheadMs) continue;
    const key = `${r.kind}|${r.sensor_id}`;
    const prev = out.get(key);
    if (!prev || new Date(prev.ts).getTime() < ts) out.set(key, r);
  }
  return out;
}
