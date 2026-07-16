import { useEffect, useRef, useState } from "react";

export interface GalvoPoint {
  x: number;
  y: number;
  t: number; // arrival ms epoch
}

const CAP = 10000;

export function useGalvoStream(): {
  pointsRef: React.MutableRefObject<GalvoPoint[]>;
  connected: boolean;
  stats: { count: number; fps: number; latest: GalvoPoint | null };
  clear: () => void;
} {
  const pointsRef = useRef<GalvoPoint[]>([]);
  const msgCountRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<{ count: number; fps: number; latest: GalvoPoint | null }>({
    count: 0,
    fps: 0,
    latest: null,
  });

  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/api/movement/position/stream`);
      ws.onopen = () => {
        setConnected(true);
        backoff = 1000;
      };
      ws.onmessage = (e) => {
        try {
          const frame = JSON.parse(e.data) as { data: { x: number; y: number } };
          const buf = pointsRef.current;
          buf.push({ x: frame.data.x, y: frame.data.y, t: performance.now() });
          if (buf.length > CAP) buf.splice(0, buf.length - CAP);
          msgCountRef.current++;
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    const interval = setInterval(() => {
      const buf = pointsRef.current;
      const dt = 0.2; // 200 ms window
      setStats({
        count: buf.length,
        fps: Math.round(msgCountRef.current / dt),
        latest: buf[buf.length - 1] ?? null,
      });
      msgCountRef.current = 0;
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(interval);
      ws?.close();
    };
  }, []);

  const clear = () => {
    pointsRef.current = [];
  };

  return { pointsRef, connected, stats, clear };
}
