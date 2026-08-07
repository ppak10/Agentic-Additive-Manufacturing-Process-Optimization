import { useCallback, useEffect, useRef, useState } from "react";

// Receives binary JPEG frames over WebSocket and writes them STRAIGHT INTO
// the consumer's <img> element (attach `imgRef`). Frames arrive at ~12 fps;
// routing them through React state re-rendered every consumer's whole pane
// on every frame — measured at ~30-40% main-thread busy at idle on Mission
// Control (2026-07-28 lag hunt). Imperative src swaps cost React nothing.
//
// State is only used for the cheap, rare transitions: `connected` (socket
// up/down) and `hasFrame` (first frame arrived — placeholder/fallback
// logic). Stale blob URLs are revoked immediately to avoid accumulation.
//
// Reconnects automatically on close with exponential backoff (1 s → 30 s).
export function useCameraStream(path: string): {
  imgRef: (el: HTMLImageElement | null) => void;
  connected: boolean;
  hasFrame: boolean;
} {
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const elRef = useRef<HTMLImageElement | null>(null);
  const currentUrl = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const imgRef = useCallback((el: HTMLImageElement | null) => {
    elRef.current = el;
    // element mounted after frames started flowing — show the latest one
    if (el && currentUrl.current) el.src = currentUrl.current;
  }, []);

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
        if (elRef.current) elRef.current.src = url;
        setHasFrame(true); // no-op re-render after the first frame
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

  return { imgRef, connected, hasFrame };
}
