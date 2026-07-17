import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { DEFECT_COLORS, DEFECT_ALPHA_FLOOR, extractBlobs } from "@/lib/defects";
import type { DefectBlob } from "@/hooks/useDefectWatch";
import { cn } from "@/lib/utils";
import { useProjection } from "@/lib/projection";

// Telemetry build lab: replay a recorded build's chamber frames, run MOCK
// inference on any point in the print (bridge /defect/replay — no events
// written), and produce curated training labels: verdicts on model blobs
// (✓ positive / ✕ negative) and hand-drawn regions. Labels land in the
// defect_labels table (mutable — curation, not telemetry) and export
// per-build to the Telemetry dataset via sls-export-labels.

const CLASSES = Object.keys(DEFECT_COLORS);

interface FrameRef { id: number; kind: string; tsMs: number }
interface ManifestEvent {
  id: number;
  ts: string;
  kind: string;
  payload: { objects?: { id: number; outline: [number, number][] }[] } | null;
}
interface Manifest {
  build: { id: string; job_name: string | null; started_at: string; ended_at: string | null };
  events: ManifestEvent[];
  framesByKind: Record<string, FrameRef[]>;
}
interface ReplayResult {
  scores: Record<string, number>;
  alerts: string[];
  maps_png?: Record<string, string>;
}
interface LabelRow {
  id: number;
  layer: number | null;
  ts: string | null;
  frame_ids: number[] | null;
  class: string;
  bbox: number[] | null;
  polarity: string;
  status: string;
  source: string;
  note: string | null;
}

export function TelemetryBuildLab() {
  const { buildId } = useParams();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [resultFrameIds, setResultFrameIds] = useState<number[]>([]);
  const [blobs, setBlobs] = useState<DefectBlob[]>([]);
  const [blobTip, setBlobTip] = useState<DefectBlob | null>(null);
  const [labels, setLabels] = useState<LabelRow[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showObjects, setShowObjects] = useState(true);
  // operator-aligned plotter→chamber projection (shared with Mission Control)
  const { H } = useProjection();
  const [speed, setSpeed] = useState(1); // frames advanced per 100 ms tick
  const [dragRect, setDragRect] = useState<[number, number, number, number] | null>(null);
  const [pendingRect, setPendingRect] = useState<[number, number, number, number] | null>(null);
  const [pendingClass, setPendingClass] = useState<string>(CLASSES[0] ?? "debris");
  const [pendingPolarity, setPendingPolarity] = useState<"positive" | "negative">("positive");
  const dragStart = useRef<[number, number] | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const mapsRef = useRef<HTMLCanvasElement | null>(null);

  const chamber = manifest?.framesByKind.chamber ?? [];
  // playback: advance `speed` frames every 100 ms; stop at the end
  useEffect(() => {
    if (!playing || chamber.length === 0) return;
    const t = setInterval(() => {
      setIdx((i) => {
        const next = i + speed;
        if (next >= chamber.length - 1) {
          setPlaying(false);
          return chamber.length - 1;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [playing, speed, chamber.length]);
  const galvo = manifest?.framesByKind.galvo ?? [];
  // layer_objects events = the recorded per-layer part geometry (builds
  // 47+; earlier builds predate the feedback recorder and have none).
  // At any replay position, the active layer's outlines = the last
  // layer_objects event at or before the frame timestamp.
  const layerEvents = useMemo(
    () =>
      (manifest?.events ?? [])
        .filter((e) => e.kind === "layer_objects" && e.payload?.objects)
        .map((e) => ({ ts: Date.parse(e.ts), objects: e.payload!.objects! }))
        .sort((a, b) => a.ts - b.ts),
    [manifest],
  );
  const frame = chamber[idx] ?? null;
  const activeLayer = useMemo(() => {
    if (!frame || layerEvents.length === 0) return null;
    let lo = 0, hi = layerEvents.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (layerEvents[mid]!.ts <= frame.tsMs) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // ordinal (1-based count of layer_objects events so far) ≈ layer number
    return best >= 0 ? { objects: layerEvents[best]!.objects, ordinal: best + 1 } : null;
  }, [frame, layerEvents]);
  const activeObjects = activeLayer?.objects ?? null;

  // ---- data loading ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/builds/${buildId}/manifest`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((m: Manifest) => {
        if (cancelled) return;
        // manifest serves camelCase tsMs; coerce defensively to number
        for (const kind of Object.keys(m.framesByKind)) {
          for (const f of m.framesByKind[kind]!) f.tsMs = Number(f.tsMs);
        }
        setManifest(m);
        setIdx(Math.floor((m.framesByKind.chamber?.length ?? 1) / 2));
      })
      .catch((e) => !cancelled && setLoadErr(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [buildId]);

  const refreshLabels = async () => {
    try {
      const r = await fetch(`/defect/labels?build_id=${buildId}`);
      if (r.ok) setLabels(await r.json());
    } catch { /* bridge offline */ }
  };
  useEffect(() => {
    void refreshLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  // ---- mock inference --------------------------------------------------------
  const runInference = async () => {
    if (!frame || running) return;
    setRunning(true);
    setResult(null);
    setBlobs([]);
    setBlobTip(null);
    try {
      // window: current frame + the next 3 (spans recoat→scan for the
      // engine's quality ranking) + the 2 nearest galvo frames by time
      const chamberIds = chamber.slice(idx, idx + 4).map((f) => f.id);
      const nearestGalvo = [...galvo]
        .sort((a, b) => Math.abs(a.tsMs - frame.tsMs) - Math.abs(b.tsMs - frame.tsMs))
        .slice(0, 2)
        .map((f) => f.id);
      const r = await fetch("/defect/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          build_id: Number(buildId),
          chamber_frame_ids: chamberIds,
          galvo_frame_ids: nearestGalvo,
        }),
      });
      if (!r.ok) throw new Error((await r.json())?.error ?? `HTTP ${r.status}`);
      const res = (await r.json()) as ReplayResult;
      setResult(res);
      setResultFrameIds(chamberIds);
    } catch (e) {
      setLoadErr(String((e as Error).message ?? e));
    } finally {
      setRunning(false);
    }
  };

  // decode + colorize maps, extract blobs (same pipeline as Mission Control)
  useEffect(() => {
    const c = mapsRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const entries = Object.entries(result?.maps_png ?? {});
    if (entries.length === 0) {
      ctx.clearRect(0, 0, c.width, c.height);
      setBlobs([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const bitmaps = await Promise.all(
        entries.map(async ([cls, b64]) => {
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          return [cls, await createImageBitmap(new Blob([bytes], { type: "image/png" }))] as const;
        }),
      );
      const first = bitmaps[0];
      if (cancelled || !first) return;
      c.width = first[1].width;
      c.height = first[1].height;
      const scratch = document.createElement("canvas");
      scratch.width = c.width;
      scratch.height = c.height;
      const sctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;
      const out = ctx.createImageData(c.width, c.height);
      const best = new Float32Array(c.width * c.height);
      const found: DefectBlob[] = [];
      for (const [cls, bm] of bitmaps) {
        sctx.clearRect(0, 0, c.width, c.height);
        sctx.drawImage(bm, 0, 0);
        const px = sctx.getImageData(0, 0, c.width, c.height).data;
        found.push(...extractBlobs(px, c.width, c.height, cls));
        const [r, g, b] = DEFECT_COLORS[cls] ?? [255, 255, 255];
        for (let i = 0; i < best.length; i++) {
          const p = px[i * 4]! / 255;
          if (p < DEFECT_ALPHA_FLOOR || p <= best[i]!) continue;
          best[i] = p;
          out.data[i * 4] = r;
          out.data[i * 4 + 1] = g;
          out.data[i * 4 + 2] = b;
          out.data[i * 4 + 3] = Math.round(p * 178);
        }
      }
      if (!cancelled) {
        ctx.putImageData(out, 0, 0);
        setBlobs(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [result]);

  // ---- labels ----------------------------------------------------------------
  const postLabel = async (payload: Record<string, unknown>) => {
    try {
      const r = await fetch("/defect/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          build_id: Number(buildId),
          ts: frame ? new Date(frame.tsMs).toISOString() : null,
          frame_ids: resultFrameIds.length > 0 ? resultFrameIds : frame ? [frame.id] : null,
          layer: activeLayer?.ordinal ?? null,
          ...payload,
        }),
      });
      if (r.ok) void refreshLabels();
    } catch { /* bridge offline */ }
  };

  const setLabelStatus = async (id: number, status: string) => {
    try {
      await fetch(`/defect/labels/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      void refreshLabels();
    } catch { /* bridge offline */ }
  };

  // ---- manual rect drawing -----------------------------------------------------
  const stageXY = (e: React.PointerEvent): [number, number] => {
    const r = stageRef.current!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };
  const onStageDown = (e: React.PointerEvent) => {
    if (!drawing) return;
    dragStart.current = stageXY(e);
    setDragRect(null);
    setPendingRect(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onStageMove = (e: React.PointerEvent) => {
    if (!drawing || !dragStart.current) return;
    const [x0, y0] = dragStart.current;
    const [x1, y1] = stageXY(e);
    setDragRect([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
  };
  const onStageUp = () => {
    if (!drawing || !dragStart.current) return;
    dragStart.current = null;
    setDragRect((r) => {
      if (r && (r[2] - r[0]) > 0.01 && (r[3] - r[1]) > 0.01) setPendingRect(r);
      return null;
    });
  };

  if (loadErr && !manifest) {
    return <div className="p-4 text-xs text-red-600">Failed to load build {buildId}: {loadErr}</div>;
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span>Build {buildId} — label lab</span>
            {manifest?.build.job_name && (
              <span className="opacity-70 font-base text-sm truncate">{manifest.build.job_name}</span>
            )}
            <Link to="/datasets/telemetry" className="ml-auto text-xs underline opacity-70">
              ← telemetry dataset
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!manifest ? (
            <div className="text-xs opacity-60">Loading frame manifest…</div>
          ) : chamber.length === 0 ? (
            <div className="text-xs opacity-60">
              No archived frames in Postgres for this build (frames import when a build closes;
              older builds may only have frames in the HF zips).
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
            <div className="grid gap-3 content-start">
              {/* stage */}
              <div className="relative border-2 border-border bg-black overflow-hidden max-w-3xl">
                <div
                  ref={stageRef}
                  className="relative w-full"
                  style={{ aspectRatio: "650 / 600", cursor: drawing ? "crosshair" : undefined }}
                  onPointerDown={onStageDown}
                  onPointerMove={onStageMove}
                  onPointerUp={onStageUp}
                >
                  {frame && (
                    <img
                      src={`/api/frames/${frame.id}`}
                      alt={`frame ${frame.id}`}
                      className="absolute inset-0 w-full h-full"
                      draggable={false}
                    />
                  )}
                  {/* recorded part outlines for the replayed layer, through
                      the operator-aligned homography (same as Mission
                      Control); recorded quads, not STL slices — meshes are
                      only servable mid-print */}
                  {showObjects && activeObjects && activeObjects.length > 0 && (
                    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
                      {activeObjects.map((o) => (
                        <polygon
                          key={o.id}
                          points={o.outline.map(([x, y]) => H(x, y).join(",")).join(" ")}
                          vectorEffect="non-scaling-stroke"
                          className="fill-white/10 stroke-white/70 [stroke-width:1.5]"
                        />
                      ))}
                    </svg>
                  )}
                  <canvas ref={mapsRef} className="absolute inset-0 w-full h-full pointer-events-none" />
                  {/* model blobs → verdict labels */}
                  {blobs.length > 0 && (
                    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
                      {blobs.map((b) => {
                        const [r, g, bl] = DEFECT_COLORS[b.class] ?? [255, 255, 255];
                        return (
                          <rect
                            key={b.key}
                            x={b.bbox[0]} y={b.bbox[1]}
                            width={b.bbox[2] - b.bbox[0]} height={b.bbox[3] - b.bbox[1]}
                            vectorEffect="non-scaling-stroke"
                            onClick={() => !drawing && setBlobTip(b)}
                            className="fill-transparent cursor-pointer [stroke-width:2]"
                            style={{ pointerEvents: drawing ? "none" : "auto", stroke: `rgb(${r},${g},${bl})` }}
                          />
                        );
                      })}
                    </svg>
                  )}
                  {/* in-progress + pending manual rects */}
                  {(dragRect ?? pendingRect) && (
                    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
                      {[dragRect ?? pendingRect!].map((r) => (
                        <rect key="draw" x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]}
                          vectorEffect="non-scaling-stroke"
                          className="fill-white/10 stroke-white [stroke-width:2] [stroke-dasharray:5,3]" />
                      ))}
                    </svg>
                  )}
                  {/* blob verdict tooltip */}
                  {blobTip && (
                    <div
                      className="absolute z-20 flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded-base border-2 border-border bg-background shadow-shadow"
                      style={{ left: `${blobTip.centroid[0] * 100}%`, top: `${blobTip.bbox[1] * 100}%`, transform: "translate(-50%, -115%)" }}
                    >
                      <span style={{ color: `rgb(${(DEFECT_COLORS[blobTip.class] ?? [255, 255, 255]).join(",")})` }}>
                        {blobTip.class}
                      </span>
                      <span className="opacity-60">{blobTip.peak.toFixed(2)}</span>
                      <button
                        className="px-1.5 rounded border border-border hover:bg-green-500/20"
                        title="Positive label: this region IS this defect"
                        onClick={() => {
                          void postLabel({ class: blobTip.class, bbox: blobTip.bbox, polarity: "positive", source: "replay" });
                          setBlobTip(null);
                        }}
                      >✓</button>
                      <button
                        className="px-1.5 rounded border border-border hover:bg-red-500/20"
                        title="Negative label: this region is NOT this defect"
                        onClick={() => {
                          void postLabel({ class: blobTip.class, bbox: blobTip.bbox, polarity: "negative", source: "replay" });
                          setBlobTip(null);
                        }}
                      >✕</button>
                      <button className="px-1 opacity-50 hover:opacity-100" onClick={() => setBlobTip(null)}>·</button>
                    </div>
                  )}
                </div>
              </div>

              {/* pending manual rect → dropdown class picker + polarity, then save */}
              {pendingRect && (
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono border-2 border-border rounded-base p-2 bg-secondary-background max-w-3xl">
                  <span className="opacity-60">label region as</span>
                  <select
                    value={pendingClass}
                    onChange={(e) => setPendingClass(e.target.value)}
                    className="border-2 border-border rounded-base bg-background px-2 py-1 text-[10px] font-mono"
                    style={{ color: `rgb(${(DEFECT_COLORS[pendingClass] ?? [128, 128, 128]).join(",")})` }}
                  >
                    {CLASSES.map((cls) => (
                      <option key={cls} value={cls}>
                        {cls}
                      </option>
                    ))}
                  </select>
                  <div className="flex rounded-base border-2 border-border overflow-hidden">
                    <button
                      className={cn("px-2 py-1", pendingPolarity === "positive" ? "bg-green-500/40" : "opacity-50 hover:opacity-100")}
                      title="positive: region IS this defect"
                      onClick={() => setPendingPolarity("positive")}
                    >
                      ✓ is
                    </button>
                    <button
                      className={cn("px-2 py-1 border-l-2 border-border", pendingPolarity === "negative" ? "bg-red-500/40" : "opacity-50 hover:opacity-100")}
                      title="negative: region is clean of this defect"
                      onClick={() => setPendingPolarity("negative")}
                    >
                      ✕ is not
                    </button>
                  </div>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 px-3 text-[10px]"
                    onClick={() => {
                      void postLabel({ class: pendingClass, bbox: pendingRect, polarity: pendingPolarity, source: "manual" });
                      setPendingRect(null);
                    }}
                  >
                    Save label
                  </Button>
                  <Button size="sm" variant="neutral" className="h-7 px-2 text-[10px]" onClick={() => setPendingRect(null)}>
                    cancel
                  </Button>
                </div>
              )}

              {/* scrubber + controls */}
              <div className="flex items-center gap-3 max-w-3xl">
                <Slider
                  min={0}
                  max={Math.max(0, chamber.length - 1)}
                  step={1}
                  value={[idx]}
                  onValueChange={([v]) => {
                    if (v === undefined) return;
                    setIdx(v);
                    setBlobTip(null);
                  }}
                  className="flex-1"
                />
                <span className="text-[10px] font-mono opacity-60 w-44 text-right">
                  {idx + 1} / {chamber.length}
                  {frame && <> · {new Date(frame.tsMs).toLocaleTimeString()}</>}
                </span>
              </div>
              <div className="flex items-center gap-2 max-w-3xl">
                <Button
                  size="sm"
                  variant={playing ? "default" : "neutral"}
                  className="h-7 px-3 text-[10px]"
                  onClick={() => setPlaying((v) => !v)}
                  disabled={chamber.length === 0}
                >
                  {playing ? "⏸ pause" : "▶ play"}
                </Button>
                <Button
                  size="sm"
                  variant="neutral"
                  className="h-7 px-2 text-[10px]"
                  title="Playback speed (frames per 100 ms tick)"
                  onClick={() => setSpeed((sp) => (sp === 1 ? 2 : sp === 2 ? 5 : sp === 5 ? 10 : 1))}
                >
                  {speed}×
                </Button>
                <Button size="sm" variant="neutral" className="h-7 px-2 text-[10px]" onClick={() => setIdx((i) => Math.max(0, i - 1))}>−1</Button>
                <Button size="sm" variant="neutral" className="h-7 px-2 text-[10px]" onClick={() => setIdx((i) => Math.min(chamber.length - 1, i + 1))}>+1</Button>
                <Button size="sm" variant="default" className="h-7 px-3 text-[10px]" onClick={() => void runInference()} disabled={running}>
                  {running ? "scoring…" : "Run model here"}
                </Button>
                <Button
                  size="sm"
                  variant="neutral"
                  className={cn("h-7 px-2 text-[10px]", drawing && "bg-amber-400 text-black")}
                  onClick={() => setDrawing((d) => !d)}
                >
                  {drawing ? "Done drawing" : "Draw label"}
                </Button>
                {layerEvents.length > 0 && (
                  <Button
                    size="sm"
                    variant={showObjects ? "default" : "neutral"}
                    className="h-7 px-2 text-[10px]"
                    onClick={() => setShowObjects((v) => !v)}
                    title="Toggle recorded part outlines for the replayed layer"
                  >
                    Objects
                  </Button>
                )}
                {result && (
                  <span className="text-[10px] font-mono opacity-70 truncate">
                    {Object.entries(result.scores).filter(([, v]) => v >= DEFECT_ALPHA_FLOOR)
                      .map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ") || "all clear"}
                  </span>
                )}
              </div>
            </div>

            {/* labels for this build — beside the replay window */}
            <div className="min-w-0 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-heading">
                <span>Labels</span>
                {labels && (
                  <Badge variant="neutral">
                    {labels.filter((l) => l.status === "active").length} active / {labels.length}
                  </Badge>
                )}
              </div>
              {!labels ? (
                <div className="text-xs opacity-60">Loading…</div>
              ) : labels.length === 0 ? (
                <div className="text-xs opacity-60">
                  No labels yet — run the model and verdict its blobs, or draw regions by hand.
                </div>
              ) : (
                <div className="flex-1 min-h-0 max-h-[36rem] overflow-y-auto border-2 border-border rounded-base">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-secondary-background">
                      <tr className="text-left border-b-2 border-border">
                        <th className="px-2 py-1">class</th>
                        <th className="px-2 py-1">±</th>
                        <th className="px-2 py-1">layer</th>
                        <th className="px-2 py-1">frame</th>
                        <th className="px-2 py-1">source</th>
                        <th className="px-2 py-1">region</th>
                        <th className="px-2 py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {labels.map((l) => (
                        <tr key={l.id} className={cn("border-b border-border/40", l.status === "rejected" && "opacity-40 line-through")}>
                          <td className="px-2 py-1" style={{ color: `rgb(${(DEFECT_COLORS[l.class] ?? [128, 128, 128]).join(",")})` }}>{l.class}</td>
                          <td className="px-2 py-1">{l.polarity === "positive" ? "✓" : "✕"}</td>
                          <td className="px-2 py-1">{l.layer ?? "—"}</td>
                          <td className="px-2 py-1 text-[10px]">{l.frame_ids?.[0] ?? "—"}</td>
                          <td className="px-2 py-1">{l.source}</td>
                          <td className="px-2 py-1 text-[10px]">{l.bbox ? l.bbox.map((v) => v.toFixed(2)).join(",") : "frame"}</td>
                          <td className="px-2 py-1">
                            <Button
                              size="sm"
                              variant="neutral"
                              className="h-5 px-1.5 text-[9px]"
                              onClick={() => void setLabelStatus(l.id, l.status === "active" ? "rejected" : "active")}
                            >
                              {l.status === "active" ? "reject" : "restore"}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
