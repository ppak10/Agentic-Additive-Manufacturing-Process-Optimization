import { useEffect, useRef, useState } from "react";

export interface Position { x: number; y: number; z1: number; z2: number; r: number }
export interface LightsState { isEnabled: boolean; lightCount: number }
export interface PowerEntry { id: string; power: number }
export interface PowermanState { maxPower: number; currentPower: number; requiredPower: number; poweredPinsDescription: string }
export interface PowerState { entries: PowerEntry[]; powerman: PowermanState }
export interface TemperatureEntry {
  id: string;
  currentTemperature: number;
  averageTemperature: number;
  targetTemperature: number | null;
  targetReached: boolean;
  settable: boolean;
}
export interface TemperatureState { entries: TemperatureEntry[] }
export interface StateSnapshot {
  position: Position;
  lights: LightsState;
  power: PowerState;
  temperature: TemperatureState;
}
export interface Timed<T> { respondedAt: string; data: T }

export function useStream(): { snapshot: Timed<StateSnapshot> | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Timed<StateSnapshot> | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/api/stream`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); backoff = 1000; };
      ws.onmessage = (e) => {
        try { setSnapshot(JSON.parse(e.data) as Timed<StateSnapshot>); } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => { cancelled = true; wsRef.current?.close(); };
  }, []);

  return { snapshot, connected };
}
