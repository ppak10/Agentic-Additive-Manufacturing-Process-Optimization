import { useEffect, useRef, useState } from "react";

export interface BedMatrixFrame {
  respondedAt: string;
  data: {
    timestamp: { totalSeconds: number };
    width: number;
    height: number;
    values: number[];
  };
}

export function useBedMatrix(): { frame: BedMatrixFrame | null; connected: boolean } {
  const [frame, setFrame] = useState<BedMatrixFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/api/temperature/bedmatrix/stream`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); backoff = 1000; };
      ws.onmessage = (e) => {
        try { setFrame(JSON.parse(e.data) as BedMatrixFrame); } catch { /* ignore */ }
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

  return { frame, connected };
}
