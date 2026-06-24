import { useCallback, useEffect, useRef, useState } from "react";

export interface CommandFrame {
  buildEpoch: string;
  layer: number;
  idx: number;
  ts: string;
  op: string;
  x: number | null;
  y: number | null;
  laser: number | null;
  speed: number | null;
  raw: string | null;
}

export interface PlotterInfo {
  width: number;
  height: number;
  version: number;
  layerCount: number;
  isEmpty: boolean;
  currentLayer: number;
  currentCmdIdx: number;
  buildEpoch: string;
  maxXY: number;
}

// Per-layer buffer cap. A dense layer in a real print is on the order of
// 10k–30k MOVE_XY calls; 50k leaves headroom and the canvas renderer can chew
// through that many lineTo() calls without dropping frames.
const CAP_PER_LAYER = 50000;
// Retain at most this many layers in memory. The trace tab only renders the
// current layer; older layers are kept briefly for cross-layer transition
// smoothing and then evicted by insertion order.
const MAX_LAYERS_IN_MEMORY = 4;

// Snapshot delivered to the canvas renderer once per animation frame.
export interface CommandDelta {
  layer: number;
  fromIdx: number;     // first idx in `commands` (== consumer's last seen + 1)
  layerChanged: boolean;
  commands: CommandFrame[];
}

export function useCommandStream(): {
  connected: boolean;
  stats: { count: number; fps: number; currentLayer: number; latest: CommandFrame | null };
  maxXY: number;
  frameSinceLastRead: () => CommandDelta;
  clear: () => void;
} {
  const buffersRef = useRef<Map<number, CommandFrame[]>>(new Map());
  const layerOrderRef = useRef<number[]>([]);
  const currentLayerRef = useRef(0);
  const lastReadIdxRef = useRef<Map<number, number>>(new Map());
  // Tracks the layer the consumer last read from. Compared against
  // currentLayerRef inside frameSinceLastRead to detect layer rollover —
  // cheaper than iterating lastReadIdxRef's keys every animation frame.
  const lastReadLayerRef = useRef<number | null>(null);
  const msgCountRef = useRef(0);
  const latestRef = useRef<CommandFrame | null>(null);

  const [connected, setConnected] = useState(false);
  const [maxXY, setMaxXY] = useState(160); // fallback bed dim; refreshed from /plotter/info
  const [stats, setStats] = useState<{
    count: number;
    fps: number;
    currentLayer: number;
    latest: CommandFrame | null;
  }>({ count: 0, fps: 0, currentLayer: 0, latest: null });

  // Insert a frame, creating + LRU-evicting layer buckets as needed.
  const ingest = (frame: CommandFrame) => {
    const buffers = buffersRef.current;
    let bucket = buffers.get(frame.layer);
    if (!bucket) {
      bucket = [];
      buffers.set(frame.layer, bucket);
      layerOrderRef.current.push(frame.layer);
      while (layerOrderRef.current.length > MAX_LAYERS_IN_MEMORY) {
        const old = layerOrderRef.current.shift()!;
        buffers.delete(old);
        lastReadIdxRef.current.delete(old);
      }
    }
    if (bucket.length < CAP_PER_LAYER) bucket.push(frame);
    if (frame.layer !== currentLayerRef.current) {
      currentLayerRef.current = frame.layer;
    }
    latestRef.current = frame;
    msgCountRef.current++;
  };

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let backoff = 1000;

    // Initial seed: ask the plugin for current state + layer commands so far.
    // The proxy route resolves these via the live plugin endpoint (not
    // Postgres), so we get the in-memory ring buffer's contents regardless of
    // whether a build is active.
    const seed = async () => {
      try {
        const r = await fetch("/api/plotter/info");
        if (!r.ok) return;
        const info = (await r.json()) as { data: PlotterInfo };
        setMaxXY(info.data.maxXY);
        currentLayerRef.current = info.data.currentLayer;
        const layer = info.data.currentLayer;
        const r2 = await fetch(`/api/plotter/layer/${layer}/commands?since=0`);
        if (!r2.ok) return;
        const payload = (await r2.json()) as {
          data: { layer: number; sinceCmdIdx: number; commands: CommandFrame[] };
        };
        for (const cmd of payload.data.commands) ingest(cmd);
      } catch {
        /* ignore — WS will still attach */
      }
    };

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/api/plotter/commands/stream`);
      ws.onopen = () => {
        setConnected(true);
        backoff = 1000;
      };
      ws.onmessage = (e) => {
        try {
          const frame = JSON.parse(e.data) as { data: CommandFrame };
          ingest(frame.data);
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

    void seed().then(connect);

    const interval = setInterval(() => {
      const layer = currentLayerRef.current;
      const buf = buffersRef.current.get(layer) ?? [];
      const dt = 0.2;
      setStats({
        count: buf.length,
        fps: Math.round(msgCountRef.current / dt),
        currentLayer: layer,
        latest: latestRef.current,
      });
      msgCountRef.current = 0;
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(interval);
      ws?.close();
    };
  }, []);

  // Returns commands appended since the last read for the current layer. If
  // the layer changed, signals layerChanged: true and returns the new layer's
  // commands from idx 0 — caller is expected to clearRect the canvas.
  // Stable identity (useCallback with no deps) — reads/writes only refs, so
  // the consumer's RAF effect mounts once instead of restarting on every
  // 200 ms stats tick.
  const frameSinceLastRead = useCallback((): CommandDelta => {
    const layer = currentLayerRef.current;
    const buf = buffersRef.current.get(layer) ?? [];
    const prevLayer = lastReadLayerRef.current;
    const layerChanged = prevLayer !== null && prevLayer !== layer;
    if (layerChanged) {
      lastReadIdxRef.current.clear();
    }
    lastReadLayerRef.current = layer;
    const lastIdx = lastReadIdxRef.current.get(layer) ?? -1;
    const fromIdx = lastIdx + 1;
    // Find the slice from fromIdx onward by buffer index, not command idx —
    // buffer is ordered by insertion which matches command idx unless we hit
    // the per-layer cap, in which case some early commands are dropped and
    // the caller's redraw won't match. CAP_PER_LAYER is sized so this only
    // happens at pathological densities; the trace is still useful.
    let bufStart = 0;
    while (bufStart < buf.length && buf[bufStart]!.idx < fromIdx) bufStart++;
    const slice = buf.slice(bufStart);
    if (slice.length > 0) {
      lastReadIdxRef.current.set(layer, slice[slice.length - 1]!.idx);
    } else if (!lastReadIdxRef.current.has(layer)) {
      lastReadIdxRef.current.set(layer, -1);
    }
    return { layer, fromIdx, layerChanged, commands: slice };
  }, []);

  const clear = useCallback(() => {
    buffersRef.current.clear();
    layerOrderRef.current = [];
    lastReadIdxRef.current.clear();
    lastReadLayerRef.current = null;
    latestRef.current = null;
  }, []);

  return { connected, stats, maxXY, frameSinceLastRead, clear };
}
