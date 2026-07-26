import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { DEFECT_COLORS } from "@/lib/defects";
import { cn } from "@/lib/utils";

// Per-build triage queue (reached via /builds/:buildId/triage): sls-analyze-build
// flags suspicious powder regions (CV suspicion sort — diff vs previous layer +
// chroma, parts masked out via the homography); this page streams the flagged
// frames FOR ONE BUILD to the human for rapid adjudication. Throughput is the
// design goal — Space dismisses a clean frame and advances; labeling a real
// anomaly is click-box → class → save. Labels land in defect_labels
// (source 'triage'), candidates get back-linked, and sls-export-labels ships
// everything per build.

const CLASSES = Object.keys(DEFECT_COLORS);

interface Candidate {
  id: number;
  build_id: number;
  layer: number | null;
  frame_id: number;
  ts: string | null;
  bbox: [number, number, number, number];
  score: number;
  method: string;
}

interface QueueFrame {
  frameId: number;
  buildId: number;
  layer: number | null;
  ts: string | null;
  candidates: Candidate[];
}

export function Labeling() {
  const { buildId } = useParams<{ buildId: string }>();
  const [queue, setQueue] = useState<QueueFrame[] | null>(null);
  const [qIdx, setQIdx] = useState(0);
  const [done, setDone] = useState(0);
  const [pickClass, setPickClass] = useState<string>(CLASSES[0] ?? "debris");
  const [busy, setBusy] = useState(false);
  // context scrubber: ±N neighboring frames around the flagged one, to
  // tell one-frame lighting flickers from things actually on the bed
  const [ctx, setCtx] = useState<{ ids: number[]; center: number } | null>(null);
  const [offset, setOffset] = useState(0);
  // draw-your-own labels, right in the queue: drag on the image (not on a
  // candidate box) → class picker → save. Green boxes = saved this visit.
  const [dragRect, setDragRect] = useState<[number, number, number, number] | null>(null);
  const [pendingRect, setPendingRect] = useState<[number, number, number, number] | null>(null);
  const [drawn, setDrawn] = useState<{ bbox: number[]; cls: string }[]>([]);
  // per-frame labeling feedback: count drives the next-button wording,
  // flash gives explicit save confirmation
  const [labeledCount, setLabeledCount] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  };
  const dragStart = useRef<[number, number] | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!buildId) return;
    try {
      const r = await fetch(`/defect/anomalies?status=pending&build_id=${buildId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = (await r.json()) as (Candidate & { frame_id: number | string })[];
      const byFrame = new Map<number, QueueFrame>();
      for (const raw of rows) {
        const c: Candidate = {
          ...raw,
          id: Number(raw.id),
          build_id: Number(raw.build_id),
          frame_id: Number(raw.frame_id),
          score: Number(raw.score),
        };
        const qf = byFrame.get(c.frame_id) ?? {
          frameId: c.frame_id,
          buildId: c.build_id,
          layer: c.layer,
          ts: c.ts,
          candidates: [],
        };
        qf.candidates.push(c);
        byFrame.set(c.frame_id, qf);
      }
      setQueue([...byFrame.values()]);
      setQIdx(0);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, [buildId]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = queue?.[qIdx] ?? null;
  useEffect(() => {
    setCtx(null);
    setOffset(0);
    setDrawn([]);
    setPendingRect(null);
    setDragRect(null);
    setLabeledCount(0);
    setFlash(null);
    if (!current) return;
    let cancelled = false;
    void fetch(`/defect/frames/context?frame_id=${current.frameId}&span=25`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.ids) setCtx(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.frameId]);
  const shownFrameId = ctx
    ? ctx.ids[Math.min(ctx.ids.length - 1, Math.max(0, ctx.center + offset))] ?? current?.frameId
    : current?.frameId;

  const advance = useCallback(() => {
    setDone((d) => d + 1);
    setQueue((q) => (q ? q.filter((_, i) => i !== qIdx) : q));
    setQIdx((i) => i); // same index now points at the next frame
  }, [qIdx]);

  const dismissFrame = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await fetch("/defect/anomalies/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: current.candidates.map((c) => c.id) }),
      });
      advance();
    } catch {
      setErr("bridge unreachable");
    } finally {
      setBusy(false);
    }
  }, [current, busy, advance]);


  const stageXY = (e: React.PointerEvent): [number, number] => {
    const r = stageRef.current!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };
  const onStageDown = (e: React.PointerEvent) => {
    // drags starting on a candidate rect are clicks, not draws
    if ((e.target as Element).tagName === "rect") return;
    dragStart.current = stageXY(e);
    setDragRect(null);
    setPendingRect(null);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onStageMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const [x0, y0] = dragStart.current;
    const [x1, y1] = stageXY(e);
    setDragRect([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
  };
  const onStageUp = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    setDragRect((r) => {
      if (r && r[2] - r[0] > 0.01 && r[3] - r[1] > 0.01) setPendingRect(r);
      return null;
    });
  };
  const saveDrawn = async () => {
    if (!pendingRect || !current) return;
    setBusy(true);
    try {
      const r = await fetch("/defect/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          build_id: current.buildId,
          layer: current.layer,
          ts: current.ts,
          // Persist the label across a ±25-frame window centered on the frame
          // being SHOWN (the operator scrubs to where the defect is clearest).
          // A real defect carries over several consecutive frames, so the label
          // should too — not just the one frame. Falls back to the single shown
          // frame if the context window hasn't loaded.
          frame_ids: ctx
            ? ctx.ids.slice(
                Math.max(0, ctx.center + offset - 25),
                ctx.center + offset + 26,
              )
            : [shownFrameId],
          class: pickClass,
          bbox: pendingRect,
          // queue-drawn regions are always POSITIVE — you draw because
          // something IS there; clean frames are handled by Space
          polarity: "positive",
          source: "triage",
        }),
      });
      if (r.ok) {
        setDrawn((d) => [...d, { bbox: pendingRect, cls: pickClass }]);
        setLabeledCount((c) => c + 1);
        showFlash(`${pickClass} label saved`);
      }
      setPendingRect(null);
    } catch {
      setErr("bridge unreachable");
    } finally {
      setBusy(false);
    }
  };

  // keyboard: Space = clean frame (dismiss all + next); arrows navigate the
  // queue (prev/next candidate); h/l scrub frames within the context window
  // (vim-style: h = previous frame, l = next frame).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        void dismissFrame();
      } else if (e.code === "ArrowRight") {
        setQIdx((i) => Math.min((queue?.length ?? 1) - 1, i + 1));
      } else if (e.code === "ArrowLeft") {
        setQIdx((i) => Math.max(0, i - 1));
      } else if (e.code === "KeyH") {
        setOffset((o) => (ctx ? Math.max(-ctx.center, o - 1) : o));
      } else if (e.code === "KeyL") {
        setOffset((o) => (ctx ? Math.min(ctx.ids.length - 1 - ctx.center, o + 1) : o));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissFrame, queue?.length, ctx]);

  return (
    <div className="p-4 grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span>Triage queue · build {buildId}</span>
            {queue && (
              <Badge variant="neutral">
                {queue.length} flagged frame{queue.length === 1 ? "" : "s"} · {done} done
              </Badge>
            )}
            {err && <span className="text-xs text-red-600">{err}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!queue ? (
            <div className="text-xs opacity-60">Loading queue…</div>
          ) : queue.length === 0 ? (
            <div className="text-xs opacity-60">
              Queue empty — run <code>uv run sls-analyze-build --build {buildId}</code> to
              flag candidates for this build, or take a bow: everything's adjudicated.
            </div>
          ) : current ? (
            <>
              <div className="relative border-2 border-border bg-black overflow-hidden">
                <div
                  ref={stageRef}
                  className="relative w-full cursor-crosshair select-none"
                  style={{ aspectRatio: "650 / 600" }}
                  onPointerDown={onStageDown}
                  onPointerMove={onStageMove}
                  onPointerUp={onStageUp}
                >
                  <img
                    src={`/api/frames/${shownFrameId}`}
                    alt={`frame ${shownFrameId}`}
                    className="absolute inset-0 w-full h-full"
                    draggable={false}
                  />
                  {/* CV candidate boxes removed from display (user:
                      they got in the way) — candidates still drive WHICH
                      frames queue and Space still dismisses them; labeling
                      is draw-only now */}
                  {(dragRect ?? pendingRect ?? (drawn.length > 0 ? drawn : null)) && (
                    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
                      {drawn.map((d, i) => (
                        <rect key={i} x={d.bbox[0]} y={d.bbox[1]} width={d.bbox[2]! - d.bbox[0]!} height={d.bbox[3]! - d.bbox[1]!}
                          vectorEffect="non-scaling-stroke"
                          className="fill-green-500/15 stroke-green-400 [stroke-width:2]" />
                      ))}
                      {(dragRect ?? pendingRect) && [dragRect ?? pendingRect!].map((r) => (
                        <rect key="draw" x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]}
                          vectorEffect="non-scaling-stroke"
                          className="fill-white/10 stroke-white [stroke-width:2] [stroke-dasharray:5,3]" />
                      ))}
                    </svg>
                  )}
                  {flash && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-3 py-1 rounded-base border-2 border-border bg-green-400 text-black text-[11px] font-heading shadow-shadow">
                      ✓ {flash}
                    </div>
                  )}
                </div>
              </div>
              {pendingRect && (
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono border-2 border-border rounded-base p-2 bg-secondary-background">
                  <span className="opacity-60">label drawn region as</span>
                  <select
                    value={pickClass}
                    onChange={(e) => setPickClass(e.target.value)}
                    className="border-2 border-border rounded-base bg-background px-2 py-1 text-[10px] font-mono"
                    style={{ color: `rgb(${(DEFECT_COLORS[pickClass] ?? [128, 128, 128]).join(",")})` }}
                  >
                    {CLASSES.map((cls) => (
                      <option key={cls} value={cls}>{cls}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="default" className="h-7 px-3 text-[10px]" onClick={() => void saveDrawn()} disabled={busy}>
                    Save label
                  </Button>
                  <Button size="sm" variant="neutral" className="h-7 px-2 text-[10px]" onClick={() => setPendingRect(null)}>
                    cancel
                  </Button>
                </div>
              )}
              {ctx && ctx.ids.length > 1 && (
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-mono opacity-60 w-20">context</span>
                  <Slider
                    min={-ctx.center}
                    max={ctx.ids.length - 1 - ctx.center}
                    step={1}
                    value={[offset]}
                    onValueChange={([v]) => v !== undefined && setOffset(v)}
                    className="flex-1 max-w-sm"
                  />
                  <span className={cn("text-[10px] font-mono w-16", offset === 0 ? "opacity-60" : "text-amber-600 font-heading")}>
                    {offset === 0 ? "flagged" : `${offset > 0 ? "+" : ""}${offset}`}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="default" size="sm" className="h-8 px-4" onClick={() => void dismissFrame()} disabled={busy}>
                  {labeledCount > 0
                    ? `Done — ${labeledCount} label${labeledCount === 1 ? "" : "s"} · next (Space)`
                    : "No anomaly — next (Space)"}
                </Button>
                <span className="text-[10px] font-mono opacity-60">
                  build {current.buildId}
                  {current.layer != null && <> · layer {current.layer}</>}
                  {" · "}{current.candidates.length} region{current.candidates.length === 1 ? "" : "s"}
                  {current.ts && <> · {new Date(current.ts).toLocaleTimeString()}</>}
                </span>
                <Link
                  to={`/datasets/telemetry/${current.buildId}`}
                  className="text-[10px] underline opacity-60 ml-auto"
                >
                  open in build lab →
                </Link>
              </div>
              <div className="text-[10px] font-mono opacity-50">
                DRAG on the frame to draw a label (green = saved) · Space = clean frame, next · ←/→ skip · context slider to check neighboring frames
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* queue table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Up next</CardTitle>
        </CardHeader>
        <CardContent>
          {!queue || queue.length === 0 ? (
            <div className="text-xs opacity-60">—</div>
          ) : (
            <div className="max-h-[36rem] overflow-y-auto border-2 border-border rounded-base">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-secondary-background">
                  <tr className="text-left border-b-2 border-border">
                    <th className="px-2 py-1">#</th>
                    <th className="px-2 py-1">layer</th>
                    <th className="px-2 py-1">regions</th>
                    <th className="px-2 py-1">max score</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((f, i) => (
                    <tr
                      key={f.frameId}
                      onClick={() => {
                        setQIdx(i);
                                      }}
                      className={cn(
                        "border-b border-border/40 cursor-pointer hover:bg-secondary-background",
                        i === qIdx && "bg-main/20",
                      )}
                    >
                      <td className="px-2 py-1">{i + 1}</td>
                      <td className="px-2 py-1">{f.layer ?? "—"}</td>
                      <td className="px-2 py-1">{f.candidates.length}</td>
                      <td className="px-2 py-1">
                        {Math.max(...f.candidates.map((c) => c.score)).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
