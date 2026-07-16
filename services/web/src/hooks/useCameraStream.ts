import { useEffect, useRef, useState } from "react";

// Receives binary JPEG frames over WebSocket and returns a blob URL ready for
// use as <img src>. Each new frame replaces the previous URL; stale URLs are
// revoked immediately to avoid memory accumulation.
//
// Reconnects automatically on close with exponential backoff (1 s → 30 s).
// Returns null until the first frame arrives.
export function useCameraStream(path: string): { src: string | null; connected: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const currentUrl = useRef<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}${path}`);
      wsRef.current = ws;
      ws.binaryType = "blob";

      ws.onopen = () => { setConnected(true); backoff = 1000; };

      ws.onmessage = (e: MessageEvent<Blob>) => {
        if (cancelled) return;
        // Revoke the previous blob URL before creating a new one to prevent
        // the browser from accumulating unreachable blob references.
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
        const url = URL.createObjectURL(e.data);
        currentUrl.current = url;
        setSrc(url);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      cancelled = true;
      // CLOSE the socket on unmount — without this, every unmount (incl.
      // vite HMR updates) leaked a live connection still receiving ~12 fps
      // of JPEG blobs; a dev session's worth of edits made pages crawl.
      wsRef.current?.close();
      wsRef.current = null;
      if (currentUrl.current) {
        URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = null;
      }
    };
  }, [path]);

  return { src, connected };
}
