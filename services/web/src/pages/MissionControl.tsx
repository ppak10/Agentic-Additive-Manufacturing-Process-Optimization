import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBedMatrix } from "@/hooks/useBedMatrix";
import { plasma, matrixStats } from "@/lib/thermal";
import { useCameraStream } from "@/hooks/useCameraStream";
import { useDefectWatch, type DefectBlob } from "@/hooks/useDefectWatch";
import { DEFECT_COLORS, DEFECT_ALPHA_FLOOR, extractBlobs } from "@/lib/defects";
import { JobPanel } from "@/panels/JobPanel";
import type { JobStatus } from "@/hooks/useJob";
import { sonarPing, pushNotify } from "@/lib/sonar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { usePlotterObjects } from "@/hooks/usePlotterObjects";
import {
  usePrintingObjects,
  excludePrintingObject,
  type PrintingObject,
} from "@/hooks/usePrintingObjects";
import { ConfirmModal } from "@/panels/BuildLayoutPanel";
import { useLayerSlices } from "@/hooks/useLayerSlices";
import { cn } from "@/lib/utils";
import {
  CAM_W,
  CAM_H,
  BED_CAM,
  ALIGN_MARGIN,
  DEFAULT_QUAD,
  QUAD_KEY,
  homography,
  projector,
  loadCalib,
  saveCalib,
  type Quad,
} from "@/lib/projection";

// Mission Control: the streamlined operator console. Top = the Inova feed
// (chamber / thermal / galvo, no card chrome); middle = the attention bar
// (the one thing of immediate concern — recording state now; watchdog
// recommendations + agent prompts land here in phase 4); bottom = the
// agentic system chat. Design rule: the user watches ONE thing, the
// system escalates into the bar when it needs them.

// Chamber feed with the streamed thermal matrix registered onto the bed.
// Calibration comes from the FIRMWARE'S OWN config (sls4all/SLS4All-Backup/
// Current/appsettings*.toml, retrieved 2026-07-16):
//   MjpegDeviceCamera: served frame 650x600 (rotated);
//     SafeWorkingArea (bed in camera px): x 105-545, y 113-547
//   Mlx90640Camera.MainBox (bed in thermal px, 32x24 sensor): x 10-24, y 9-23
// The thermal canvas is cropped to MainBox and pinned over SafeWorkingArea.
const BED_THERM = { sx: 10, sy: 9, sw: 15, sh: 15 }; // MainBox, inclusive
// Full 32x24 matrix placement, extrapolated from the MainBox<->SafeWorkingArea
// correspondence (same px scale, no crop): overlay extends past the stage and
// is clipped by the pane, covering the whole chamber view bed-registered.
const THERM_W = 32, THERM_H = 24;
// Operator-trimmed crop (2026-07-16): the leftmost 7 and rightmost 4
// thermal columns, and the TOP 5 rows, fall outside the chamber view —
// drop them. Bed cells (x 10-24, y 9-23) remain fully inside the kept
// range.
const THERM_CROP = { sx: 7, sw: THERM_W - 7 - 4, sy: 5, sh: THERM_H - 5 }; // cols 7..27, rows 5..23
// Thermal grid → plotter-uv homography quad (the T in thermal→image =
// H∘T): plotter-space positions of the thermal grid's 4 corners, seeded
// FLAT from Mlx90640 MainBox (bed = cells x 10-24, y 9-23 → linear
// extrapolation). The DB row (calibrations kind='thermal_to_plotter')
// overrides on load; a dedicated thermal align mode can refine it later —
// the thermal camera sits elsewhere, so its true T has its own
// perspective. Composing with H means the temperature grid inherits the
// video camera's perspective + fisheye AND every future re-align for free.
const THERMAL_T_SEED: Quad = [
  [(0 - BED_THERM.sx) / BED_THERM.sw, (0 - BED_THERM.sy) / BED_THERM.sh],
  [(THERM_W - BED_THERM.sx) / BED_THERM.sw, (0 - BED_THERM.sy) / BED_THERM.sh],
  [(THERM_W - BED_THERM.sx) / BED_THERM.sw, (THERM_H - BED_THERM.sy) / BED_THERM.sh],
  [(0 - BED_THERM.sx) / BED_THERM.sw, (THERM_H - BED_THERM.sy) / BED_THERM.sh],
];

// Plotter → chamber registration for the exclude-object overlay. The flat
// BED_CAM rect ignores the camera's perspective (angled view + fisheye),
// so raster outlines drift off the parts. Instead: a projective homography
// from the plotter's unit square to a user-aligned quadrilateral in image
// coords — the operator drags the four corners ("Align" mode) until the
// outlines sit on the actual scan marks; corners persist in localStorage.

// Exported so the conversation artifact panel can surface the same live feed
// while a print is running (see panels/ArtifactPanel.tsx).
export function ChamberThermalPane({ phase }: { phase: string | null }) {
  // object overlays are meaningful only while layers print — PrintCap,
  // Cooling, idle etc. have no current-layer objects by definition
  const printing = phase === "Layers";
  const chamber = useCameraStream("/api/camera/chamber/stream");
  const { frame, connected: thermalOn } = useBedMatrix();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const defectRef = useRef<HTMLCanvasElement | null>(null);
  // Overlay toggles live in the URL (?temp=0&objects=0&defects=0; absent =
  // on) so views are shareable/reload-proof AND addressable by a future
  // ui_navigate MCP tool — agent control reduces to "apply this path +
  // query" whether delivered as a deep link or pushed live. replace:true
  // keeps toggling out of the back-button history.
  const [searchParams, setSearchParams] = useSearchParams();
  const readToggle = (key: string) => searchParams.get(key) !== "0";
  const makeToggle = (key: string) => (fn: (v: boolean) => boolean) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const on = fn(next.get(key) !== "0");
        if (on) next.delete(key);
        else next.set(key, "0");
        return next;
      },
      { replace: true },
    );
  const showTemp = readToggle("temp");
  const showDefects = readToggle("defects");
  const showObjects = readToggle("objects");
  const setShowTemp = useMemo(() => makeToggle("temp"), [searchParams]);
  const setShowDefects = useMemo(() => makeToggle("defects"), [searchParams]);
  const setShowObjects = useMemo(() => makeToggle("objects"), [searchParams]);
  const { latest: defectLatest, sendFeedback } = useDefectWatch(5_000);
  const defectMaps = defectLatest?.result.maps_png;
  // per-region feedback: blobs extracted from the decoded maps; clicking
  // one opens a small ✓/✕ tooltip whose verdict is scoped to that blob
  const [blobs, setBlobs] = useState<DefectBlob[]>([]);
  const [blobTip, setBlobTip] = useState<DefectBlob | null>(null);
  // Live defect labeling ("Label" mode): drag a box on the chamber → pick a
  // class → save a POSITIVE training label to defect_labels (source 'live'),
  // independent of model alerts. bbox is in normalized 0..1 chamber-frame
  // coords (same space as the model maps + Triage). build_id comes from
  // recorder health at submit; frame_ids stay null and get a ±10 window
  // resolved from the submit ts post-import (live frames have no ids yet).
  const [labeling, setLabeling] = useState(false);
  const labelSvgRef = useRef<SVGSVGElement | null>(null);
  const labelDragStart = useRef<[number, number] | null>(null);
  const [labelDrag, setLabelDrag] = useState<[number, number, number, number] | null>(null);
  const [labelPending, setLabelPending] = useState<[number, number, number, number] | null>(null);
  const [labelClass, setLabelClass] = useState<string>(Object.keys(DEFECT_COLORS)[0] ?? "debris");
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelSaved, setLabelSaved] = useState<{ bbox: number[]; cls: string }[]>([]);
  const [labelMsg, setLabelMsg] = useState<string | null>(null);
  // Sonar + push on each NEW alerting verdict (edge on event id, not
  // level — a persisting alert must not re-ping every poll). Lived in the
  // attention bar until it was replaced by the JobPanel card.
  const lastAlertEvent = useRef<number | null>(null);
  useEffect(() => {
    const alerts = defectLatest?.result.alerts ?? [];
    if (alerts.length === 0 || defectLatest?.eventId == null) return;
    if (lastAlertEvent.current === defectLatest.eventId) return;
    lastAlertEvent.current = defectLatest.eventId;
    sonarPing();
    pushNotify(
      "Inova: defect alert",
      `Layer ${defectLatest.layer}: ${alerts.join(", ")} — blob boxes on the chamber card.`,
    );
  }, [defectLatest]);
  // Interactive exclude-object overlay: current-layer outlines from the
  // plotter (normalized 0..1 over its raster), projected through the
  // operator-aligned homography quad onto the chamber image. Click a part
  // → same confirm flow as the Feed's Build Layout; the exclude POST is
  // recorded server-side as an operator_action event.
  const plotterObjects = usePlotterObjects(2000);
  const { objects: printingObjects, refresh: refreshObjects } = usePrintingObjects(2000);
  const [{ quad, k1 }, setCalib] = useState(loadCalib);
  // DB is the shared authoritative calibration store — on mount, adopt the
  // calibrations-table row if it's newer than what this browser saved
  // locally (whoever aligned most recently wins, across machines)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/calibration/plotter_to_camera");
        if (!r.ok) return; // recorder endpoint not deployed yet, or no row
        const row = await r.json();
        const p = row?.payload;
        if (!Array.isArray(p?.quad) || p.quad.length !== 4) return;
        let localSavedAt = 0;
        try {
          localSavedAt = Number(JSON.parse(localStorage.getItem(QUAD_KEY) ?? "{}")?.savedAt) || 0;
        } catch { /* no local save */ }
        if (cancelled || new Date(row.created_at).getTime() <= localSavedAt) return;
        setCalib({ quad: p.quad as Quad, k1: Number(p.k1) || 0 });
      } catch { /* offline — local/env values stand */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const setQuad = (fn: (q: Quad) => Quad) =>
    setCalib((c) => ({ ...c, quad: fn(c.quad) }));
  const [aligning, setAligning] = useState(false);
  const dragIdx = useRef<number | null>(null);
  const overlaySvgRef = useRef<SVGSVGElement | null>(null);
  const H = useMemo(() => projector(quad, k1), [quad, k1]);
  // T: thermal grid → plotter uv (DB-overridable, flat MainBox seed);
  // PT = H∘T projects a thermal cell coordinate onto the chamber image
  const [thermQuad, setThermQuad] = useState<Quad>(THERMAL_T_SEED);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/calibration/thermal_to_plotter");
        if (!r.ok) return; // endpoint not deployed yet / no row — seed stands
        const row = await r.json();
        if (!cancelled && Array.isArray(row?.payload?.quad) && row.payload.quad.length === 4) {
          setThermQuad(row.payload.quad as Quad);
        }
      } catch { /* offline — seed stands */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const PT = useMemo(() => {
    const T = homography(thermQuad);
    return (tx: number, ty: number): [number, number] => {
      const [u, v] = T(tx / THERM_W, ty / THERM_H);
      return H(u, v);
    };
  }, [thermQuad, H]);
  const onQuadDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragIdx.current == null || !overlaySvgRef.current) return;
    const r = overlaySvgRef.current.getBoundingClientRect();
    // While aligning the SVG extends ALIGN_MARGIN beyond the image on every
    // side (viewBox -M..1+M), so map the pointer into that space — corners
    // may legitimately sit outside the visible frame (perspective quads do).
    const fu = (e.clientX - r.left) / r.width;
    const fv = (e.clientY - r.top) / r.height;
    const span = 1 + 2 * ALIGN_MARGIN;
    const u = Math.min(1 + ALIGN_MARGIN, Math.max(-ALIGN_MARGIN, -ALIGN_MARGIN + fu * span));
    const v = Math.min(1 + ALIGN_MARGIN, Math.max(-ALIGN_MARGIN, -ALIGN_MARGIN + fv * span));
    setQuad((q) => {
      const n = q.map((c, i) => (i === dragIdx.current ? [u, v] : c)) as Quad;
      return n;
    });
  };
  const endQuadDrag = () => {
    if (dragIdx.current == null) return;
    dragIdx.current = null;
    setCalib((c) => {
      saveCalib(c.quad, c.k1);
      return c;
    });
  };
  const [pendingExclude, setPendingExclude] = useState<{
    obj: PrintingObject;
    action: "exclude" | "include";
  } | null>(null);
  // Vector cross-sections of the current layer (shared hook — the Feed's
  // Build Layout uses the same pipeline), in normalized plotter space;
  // rendered through the chamber homography below.
  const slices = useLayerSlices(plotterObjects, printingObjects, showObjects && printing);
  const [excludeBusy, setExcludeBusy] = useState(false);
  const [excludeError, setExcludeError] = useState<string | null>(null);
  const onConfirmExclude = async () => {
    if (!pendingExclude) return;
    setExcludeBusy(true);
    setExcludeError(null);
    try {
      await excludePrintingObject(pendingExclude.obj.id, pendingExclude.action === "exclude");
      setPendingExclude(null);
      refreshObjects();
    } catch (e) {
      setExcludeError((e as Error).message ?? String(e));
    } finally {
      setExcludeBusy(false);
    }
  };

  // ── live labeling handlers ──
  // Normalized pointer position within the label SVG (= the chamber image).
  const labelXY = (e: React.PointerEvent): [number, number] => {
    const r = labelSvgRef.current!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };
  const onLabelDown = (e: React.PointerEvent<SVGSVGElement>) => {
    setLabelMsg(null);
    labelDragStart.current = labelXY(e);
    setLabelDrag(null);
    setLabelPending(null);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onLabelMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!labelDragStart.current) return;
    const [x0, y0] = labelDragStart.current;
    const [x1, y1] = labelXY(e);
    setLabelDrag([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
  };
  const onLabelUp = () => {
    if (!labelDragStart.current) return;
    labelDragStart.current = null;
    setLabelDrag((r) => {
      // ignore stray clicks; require a box with some area
      if (r && r[2] - r[0] > 0.01 && r[3] - r[1] > 0.01) setLabelPending(r);
      return null;
    });
  };
  const submitLabel = async () => {
    if (!labelPending || labelBusy) return;
    setLabelBusy(true);
    setLabelMsg(null);
    try {
      // build id + layer from the model's latest inference if running; fall
      // back to recorder health (build) and the live job's layer counter
      // (phaseDone during the Layers phase) so labeling works with the model off
      let buildId = defectLatest?.buildId ?? null;
      let layer = defectLatest?.layer ?? null;
      if (buildId == null || layer == null) {
        try {
          const [h, j] = await Promise.all([
            fetch("/api/health/recording").then((r) => (r.ok ? r.json() : null)),
            fetch("/api/job/current").then((r) => (r.ok ? r.json() : null)),
          ]);
          if (buildId == null) buildId = h?.build?.current_build_id ?? null;
          if (layer == null) layer = j?.phaseDone ?? null;
        } catch { /* recorder/firmware unreachable */ }
      }
      if (buildId == null) {
        setLabelMsg("no active build to label");
        return;
      }
      const r = await fetch("/defect/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          build_id: buildId,
          layer,
          ts: new Date().toISOString(),
          frame_ids: null, // ±10 window resolved from ts post-import
          class: labelClass,
          bbox: labelPending,
          polarity: "positive",
          source: "live",
        }),
      });
      if (!r.ok) {
        setLabelMsg(`save failed (${r.status})`);
        return;
      }
      setLabelSaved((s) => [...s, { bbox: labelPending, cls: labelClass }]);
      setLabelPending(null);
      setLabelMsg(`${labelClass} label saved`);
    } catch {
      setLabelMsg("bridge unreachable");
    } finally {
      setLabelBusy(false);
    }
  };
  // Colorize the alerted classes' anomaly maps into one overlay. The maps
  // live in the model's input space = the whole chamber frame resized
  // square, so the canvas just stretches over the full image (unlike the
  // thermal overlay, no bed registration involved). Per pixel, the class
  // with the highest probability wins; alpha tracks that probability.
  useEffect(() => {
    const c = defectRef.current;
    if (!c || !showDefects || labeling) return; // no work while hidden / labeling
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const entries = Object.entries(defectMaps ?? {});
    if (entries.length === 0) {
      ctx.clearRect(0, 0, c.width, c.height);
      setBlobs([]);
      setBlobTip(null);
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
      const foundBlobs: DefectBlob[] = [];
      for (const [cls, bm] of bitmaps) {
        sctx.clearRect(0, 0, c.width, c.height);
        sctx.drawImage(bm, 0, 0);
        const px = sctx.getImageData(0, 0, c.width, c.height).data;
        foundBlobs.push(...extractBlobs(px, c.width, c.height, cls));
        const [r, g, b] = DEFECT_COLORS[cls] ?? [255, 255, 255];
        for (let i = 0; i < best.length; i++) {
          const p = px[i * 4]! / 255;
          if (p < DEFECT_ALPHA_FLOOR || p <= best[i]!) continue;
          best[i] = p;
          out.data[i * 4] = r;
          out.data[i * 4 + 1] = g;
          out.data[i * 4 + 2] = b;
          out.data[i * 4 + 3] = Math.round(p * 178); // cap at ~70% wash
        }
      }
      if (!cancelled) {
        ctx.putImageData(out, 0, 0);
        setBlobs(foundBlobs);
        setBlobTip(null); // new maps invalidate an open tooltip
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defectMaps, showDefects, labeling]);
  // Stats over BED pixels only (MainBox crop) — full-matrix stats include
  // cold chamber surroundings and understate the bed average.
  const stats = useMemo(() => {
    if (!frame) return null;
    const { width, values } = frame.data;
    const bed: number[] = [];
    for (let y = BED_THERM.sy; y < BED_THERM.sy + BED_THERM.sh; y++)
      for (let x = BED_THERM.sx; x < BED_THERM.sx + BED_THERM.sw; x++)
        bed.push(values[y * width + x]);
    return matrixStats(bed);
  }, [frame]);
  // Per-cell temperature DIGITS, font-colored by the shared plasma palette
  // (normalized over the visible crop). Every cell center and grid vertex
  // is projected through PT = H∘T, so the grid follows the bed's
  // perspective + fisheye exactly like the part vectors do (it used to be
  // a flat CSS rectangle that visibly disagreed at the edges). Dark halo
  // via strokeText, NOT shadowBlur — canvas shadows janked the pane.
  useEffect(() => {
    if (!frame || !canvasRef.current || !showTemp || labeling) return; // no work while hidden / labeling
    const { width, values } = frame.data;
    const c = canvasRef.current;
    const S = 2; // supersample for crisp glyphs
    c.width = CAM_W * S;
    c.height = CAM_H * S;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const px = (tx: number, ty: number): [number, number] => {
      const [x, y] = PT(tx, ty);
      return [x * CAM_W * S, y * CAM_H * S];
    };
    let min = Infinity, max = -Infinity;
    for (let y = THERM_CROP.sy; y < THERM_CROP.sy + THERM_CROP.sh; y++)
      for (let x = THERM_CROP.sx; x < THERM_CROP.sx + THERM_CROP.sw; x++) {
        const v = values[y * width + x]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    const range = max - min || 1;
    // dashed 1px cell grid, alternating black/white segments — projected
    // polylines (one vertex per cell step approximates the fisheye curve)
    ctx.save();
    ctx.lineWidth = S;
    const polyline = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    };
    for (const [color, offset] of [["rgba(0,0,0,0.6)", 0], ["rgba(255,255,255,0.6)", 4]] as const) {
      ctx.strokeStyle = color;
      ctx.setLineDash([4 * S, 4 * S]);
      ctx.lineDashOffset = offset * S;
      for (let x = THERM_CROP.sx; x <= THERM_CROP.sx + THERM_CROP.sw; x++) {
        const pts: [number, number][] = [];
        for (let y = THERM_CROP.sy; y <= THERM_CROP.sy + THERM_CROP.sh; y++) pts.push(px(x, y));
        polyline(pts);
      }
      for (let y = THERM_CROP.sy; y <= THERM_CROP.sy + THERM_CROP.sh; y++) {
        const pts: [number, number][] = [];
        for (let x = THERM_CROP.sx; x <= THERM_CROP.sx + THERM_CROP.sw; x++) pts.push(px(x, y));
        polyline(pts);
      }
    }
    ctx.restore();
    ctx.font = `bold ${13 * S}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3 * S;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineJoin = "round";
    for (let y = THERM_CROP.sy; y < THERM_CROP.sy + THERM_CROP.sh; y++)
      for (let x = THERM_CROP.sx; x < THERM_CROP.sx + THERM_CROP.sw; x++) {
        const v = values[y * width + x]!;
        const [r, g, b] = plasma((v - min) / range);
        const [tx, ty] = px(x + 0.5, y + 0.5);
        const label = v.toFixed(0);
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        ctx.fillText(label, tx, ty);
      }
  }, [frame, showTemp, PT, labeling]);
  return (
    <Card className="h-full min-h-0 flex flex-col gap-2 py-3">
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span>Chamber</span>
          <Badge
            variant={chamber.connected ? "neutral" : "default"}
            className={cn("text-[10px] font-mono", !chamber.connected && "bg-red-600 text-white")}
          >
            {chamber.connected ? "live" : "offline"}
          </Badge>
          {!thermalOn && (
            <span className="text-[10px] font-mono opacity-60">thermal offline</span>
          )}
          {stats && (
            <span className="text-[10px] font-mono opacity-60">
              bed {stats.min.toFixed(0)} / {stats.avg.toFixed(1)} / {stats.max.toFixed(0)} °C
            </span>
          )}
          {/* overlay toolbar — neobrutalist toggles, pressed = active */}
          <div className="ml-auto flex gap-1.5">
            {([
              ["Objects", showObjects, setShowObjects,
               "Toggle current-layer part outlines (click a part to exclude it)"],
              ["Defects", showDefects, setShowDefects,
               "Toggle the defect anomaly-map overlay (appears when the model alerts)"],
              ["Temperature (°C)", showTemp, setShowTemp,
               "Toggle the temperature grid overlay"],
            ] as const).map(([label, on, set, title]) => (
              <Button
                key={label}
                size="sm"
                variant={on ? "default" : "neutral"}
                onClick={() => set((v: boolean) => !v)}
                disabled={labeling}
                title={labeling ? "Overlays hidden while labeling" : title}
                className={cn(
                  "h-7 px-2 text-[10px] font-mono",
                  (!on || labeling) && "opacity-60 hover:opacity-100",
                )}
              >
                {label}
              </Button>
            ))}
            {/* live defect labeling — draw boxes on the chamber, saved as
                positive training labels (defect_labels, source 'live') */}
            <Button
              size="sm"
              variant="neutral"
              onClick={() => {
                setLabeling((v) => !v);
                setAligning(false);
                setBlobTip(null);
                setLabelPending(null);
                setLabelDrag(null);
                setLabelMsg(null);
                // clear the drawn boxes so a new labeling session starts with a
                // clean bed (they're already persisted to defect_labels)
                setLabelSaved([]);
              }}
              title="Draw defect labels on the live chamber (saved as positive training labels)"
              className={cn(
                "h-7 px-2 text-[10px] font-mono",
                labeling ? "bg-amber-400 text-black" : "opacity-60 hover:opacity-100",
              )}
            >
              {labeling ? "Done labeling" : "Label"}
            </Button>
            {showObjects && !labeling && (
              <Button
                size="sm"
                variant="neutral"
                onClick={() => {
                  setAligning((v) => !v);
                  setLabeling(false);
                }}
                title="Drag the four corners until part outlines sit on the rastered marks (perspective homography; saved to the calibrations table)"
                className={cn(
                  "h-7 px-2 text-[10px] font-mono",
                  aligning ? "bg-amber-400 text-black" : "opacity-60 hover:opacity-100",
                )}
              >
                {aligning ? "Done aligning" : "Align"}
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      {/* extra bottom padding while aligning — the bottom quad handles sit
          near the image edge and need grab room clear of the attention bar */}
      <CardContent className={cn("flex-1 min-h-0 px-3", aligning ? "pb-10" : "pb-0")}>
        <div className={cn(
          // [container-type:size] powers the stage's cqw/cqh contain-fit
          "relative h-full min-h-0 border-2 border-border bg-black flex items-center justify-center [container-type:size]",
          // clipping must be OFF while aligning — corner handles live beyond
          // the image edges (ALIGN_MARGIN workspace)
          aligning ? "overflow-visible" : "overflow-hidden",
        )}>
          {/* aspect-locked stage: the largest 650:600 box fitting BOTH
              container dimensions (h-full alone broke the ratio once the
              xl layout made width the constraint) — percentage overlays
              register on the image either way */}
          <div
            className="relative"
            style={{
              width: `min(100cqw, calc(100cqh * ${CAM_W / CAM_H}))`,
              height: `min(100cqh, calc(100cqw * ${CAM_H / CAM_W}))`,
            }}
          >
            {chamber.src ? (
              <img src={chamber.src} alt="chamber" className="absolute inset-0 w-full h-full" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs opacity-40 text-white">
                waiting for chamber…
              </div>
            )}
            {/* align controls — float over the feed's top-right while
                aligning (moved out of the card header so they sit with the
                thing they warp). z-20 keeps them above the align overlay SVG
                (z-10) and its corner handles. */}
            {aligning && (
              <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5">
                <label
                  className="flex items-center gap-2 text-[10px] font-mono px-2 py-1 rounded-base border-2 border-border bg-secondary-background"
                  title="Fisheye correction — bows the middle of the bed in/out while the quad corners stay pinned"
                >
                  fisheye
                  <Slider
                    min={-0.5}
                    max={0.5}
                    step={0.01}
                    value={[k1]}
                    onValueChange={([v]) => {
                      if (v === undefined) return;
                      setCalib((c) => {
                        saveCalib(c.quad, v);
                        return { ...c, k1: v };
                      });
                    }}
                    className="w-24"
                  />
                  <span className="w-8 text-right">{k1.toFixed(2)}</span>
                </label>
                <Button
                  size="sm"
                  variant="neutral"
                  onClick={() => {
                    setCalib({ quad: DEFAULT_QUAD, k1: 0 });
                    saveCalib(DEFAULT_QUAD, 0);
                  }}
                  title="Reset to the flat SafeWorkingArea rect, no fisheye"
                  className="h-7 px-2 text-[10px] font-mono"
                >
                  Reset
                </Button>
              </div>
            )}
            {/* full-frame: cells are projected through H∘T per vertex, no
                CSS placement involved */}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ display: showTemp && !labeling ? undefined : "none" }}
            />
            {/* defect anomaly maps span the full frame (model input = whole
                chamber view), so this canvas pins to the image, not the bed */}
            <canvas
              ref={defectRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ display: showDefects && !labeling ? undefined : "none" }}
            />
            {/* per-blob feedback layer: one clickable box per connected
                anomaly region (map space = full frame). Click → ✓/✕ tooltip
                scoped to THAT blob; answered blobs dim + dash. */}
            {showDefects && !labeling && blobs.length > 0 && (
              <svg
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
                style={{ pointerEvents: "none" }}
              >
                {blobs.map((b) => {
                  const [r, g, bl] = DEFECT_COLORS[b.class] ?? [255, 255, 255];
                  const verdict = defectLatest?.feedback[b.key];
                  return (
                    <rect
                      key={b.key}
                      x={b.bbox[0]}
                      y={b.bbox[1]}
                      width={b.bbox[2] - b.bbox[0]}
                      height={b.bbox[3] - b.bbox[1]}
                      vectorEffect="non-scaling-stroke"
                      onClick={() => setBlobTip(b)}
                      className="fill-transparent cursor-pointer [stroke-width:2]"
                      style={{
                        pointerEvents: aligning ? "none" : "auto",
                        stroke: `rgb(${r},${g},${bl})`,
                        strokeDasharray: verdict ? "3,3" : undefined,
                        opacity: verdict ? 0.35 : 1,
                      }}
                    />
                  );
                })}
              </svg>
            )}
            {blobTip && !labeling && defectLatest?.eventId != null && (
              <div
                className="absolute z-20 flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded border-2 border-border bg-background shadow-shadow"
                style={{
                  left: `${blobTip.centroid[0] * 100}%`,
                  top: `${blobTip.bbox[1] * 100}%`,
                  transform: "translate(-50%, -115%)",
                }}
              >
                <span style={{ color: `rgb(${(DEFECT_COLORS[blobTip.class] ?? [255, 255, 255]).join(",")})` }}>
                  {blobTip.class}
                </span>
                <span className="opacity-60">{blobTip.peak.toFixed(2)}</span>
                <button
                  onClick={() => {
                    void sendFeedback(defectLatest.eventId!, blobTip.class, "correct", blobTip);
                    setBlobTip(null);
                  }}
                  title={`Correct: this region IS ${blobTip.class}`}
                  className="px-1.5 rounded border border-border hover:bg-green-500/20"
                >
                  ✓
                </button>
                <button
                  onClick={() => {
                    void sendFeedback(defectLatest.eventId!, blobTip.class, "incorrect", blobTip);
                    setBlobTip(null);
                  }}
                  title={`Incorrect: this region is NOT ${blobTip.class}`}
                  className="px-1.5 rounded border border-border hover:bg-red-500/20"
                >
                  ✕
                </button>
                <button
                  onClick={() => setBlobTip(null)}
                  className="px-1 opacity-50 hover:opacity-100"
                  title="Close"
                >
                  ·
                </button>
              </div>
            )}
            {/* exclude-object overlay: plotter outlines projected through the
                operator-aligned homography (unit square → quad, full-frame
                SVG) so they land on the rastered marks despite the camera's
                perspective. Excluded parts vanish from /plotter/objects, so
                everything drawn here is excludable. "Align" mode exposes the
                four quad corners as drag handles; the quad persists in
                localStorage (agentic-sls.plotter-quad). */}
            {showObjects && !labeling && (aligning || (printing && plotterObjects && (plotterObjects.objects.length > 0 || slices.some((sl) => sl.loops.length > 0)))) && (
              <svg
                ref={overlaySvgRef}
                viewBox={
                  aligning
                    ? `${-ALIGN_MARGIN} ${-ALIGN_MARGIN} ${1 + 2 * ALIGN_MARGIN} ${1 + 2 * ALIGN_MARGIN}`
                    : "0 0 1 1"
                }
                preserveAspectRatio="none"
                className="absolute"
                style={
                  aligning
                    ? {
                        left: `${-ALIGN_MARGIN * 100}%`,
                        top: `${-ALIGN_MARGIN * 100}%`,
                        width: `${(1 + 2 * ALIGN_MARGIN) * 100}%`,
                        height: `${(1 + 2 * ALIGN_MARGIN) * 100}%`,
                        // NONE even while aligning — the extended surface
                        // overlaps the card toolbar and would swallow its
                        // clicks. Only the handles take pointerdown; their
                        // pointer capture makes moves bubble up to this
                        // svg's onPointerMove regardless.
                        pointerEvents: "none",
                        zIndex: 10,
                      }
                    : { inset: 0, width: "100%", height: "100%", pointerEvents: "none" }
                }
                onPointerMove={aligning ? onQuadDrag : undefined}
                onPointerUp={aligning ? endQuadDrag : undefined}
                onPointerLeave={aligning ? endQuadDrag : undefined}
              >
                {(printing ? printingObjects ?? [] : []).filter((p) => !p.isExcluded).map((part) => {
                  const obj = plotterObjects?.objects.find((o) => o.id === part.id);
                  const slice = slices.find((s) => s.id === part.id);
                  // a part renders as soon as its SLICE exists — before the
                  // first raster puts it in /plotter/objects; the quad
                  // fallback still needs the plot entry
                  if (!slice?.loops.length && !obj) return null;
                  const onPick = () => {
                    if (aligning) return;
                    setExcludeError(null);
                    setPendingExclude({
                      obj: part,
                      action: part.isExcluded ? "include" : "exclude",
                    });
                  };
                  const title = `${part.name} (#${part.id}) — click to exclude`;
                  // vector cross-section when the slicer has it (true STL
                  // geometry, holes via evenodd); bounding quad as fallback
                  if (slice && slice.loops.length > 0) {
                    const d = slice.loops
                      .map(
                        (loop) =>
                          `M ${loop.map(([u, v]) => H(u, v).map((n) => n.toFixed(4)).join(",")).join(" L ")} Z`,
                      )
                      .join(" ");
                    return (
                      <path
                        key={part.id}
                        d={d}
                        fillRule="evenodd"
                        vectorEffect="non-scaling-stroke"
                        style={{ pointerEvents: aligning ? "none" : "auto" }}
                        onClick={onPick}
                        className="cursor-pointer fill-white/10 stroke-white/80 [stroke-width:1.5] hover:fill-red-500/40 hover:stroke-red-400 transition-all"
                      >
                        <title>{title}</title>
                      </path>
                    );
                  }
                  if (!obj) return null;
                  return (
                    <polygon
                      key={part.id}
                      points={obj.outline
                        .map(([x, y]) => H(x, y).join(","))
                        .join(" ")}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: aligning ? "none" : "auto" }}
                      onClick={onPick}
                      className="cursor-pointer fill-white/10 stroke-white/80 [stroke-width:1.5] hover:fill-red-500/40 hover:stroke-red-400 transition-all"
                    >
                      <title>{title}</title>
                    </polygon>
                  );
                })}
                {aligning && (
                  <>
                    <polygon
                      points={quad.map((c) => c.join(",")).join(" ")}
                      vectorEffect="non-scaling-stroke"
                      className="fill-none stroke-amber-400 [stroke-width:1.5] [stroke-dasharray:6,4]"
                      style={{ pointerEvents: "none" }}
                    />
                    {quad.map(([x, y], i) => (
                      <circle
                        key={i}
                        cx={x}
                        cy={y}
                        r={0.014}
                        onPointerDown={(e) => {
                          dragIdx.current = i;
                          (e.target as Element).setPointerCapture?.(e.pointerId);
                        }}
                        className="fill-amber-400/80 stroke-black cursor-move"
                        style={{ pointerEvents: "auto" }}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </>
                )}
              </svg>
            )}
            {showDefects && !labeling && defectLatest && Object.keys(defectMaps ?? {}).length > 0 && (
              <span className="absolute top-1 right-1 text-[10px] font-mono px-1 rounded bg-black/60 text-white flex gap-2">
                <span className="opacity-70">layer {defectLatest.layer}</span>
                {Object.keys(defectMaps ?? {}).map((cls) => {
                  const [r, g, b] = DEFECT_COLORS[cls] ?? [255, 255, 255];
                  return (
                    <span key={cls} style={{ color: `rgb(${r},${g},${b})` }}>
                      {cls} {(defectLatest.result.scores[cls] ?? 0).toFixed(2)}
                    </span>
                  );
                })}
              </span>
            )}
            {/* live labeling overlay — on top (z-30) so drags don't hit the
                object/defect layers; captures pointer events only in Label
                mode. Saved boxes stay green for the session. */}
            {labeling && (
              <svg
                ref={labelSvgRef}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full cursor-crosshair"
                style={{ zIndex: 30, pointerEvents: "auto" }}
                onPointerDown={onLabelDown}
                onPointerMove={onLabelMove}
                onPointerUp={onLabelUp}
              >
                {labelSaved.map((d, i) => (
                  <rect
                    key={i}
                    x={d.bbox[0]}
                    y={d.bbox[1]}
                    width={d.bbox[2]! - d.bbox[0]!}
                    height={d.bbox[3]! - d.bbox[1]!}
                    vectorEffect="non-scaling-stroke"
                    className="fill-green-500/15 stroke-green-400 [stroke-width:2]"
                  />
                ))}
                {(() => {
                  const r = labelDrag ?? labelPending;
                  return r ? (
                    <rect
                      x={r[0]}
                      y={r[1]}
                      width={r[2] - r[0]}
                      height={r[3] - r[1]}
                      vectorEffect="non-scaling-stroke"
                      className="fill-white/10 stroke-white [stroke-width:2] [stroke-dasharray:5,3]"
                    />
                  ) : null;
                })()}
              </svg>
            )}
            {labeling && labelPending && (
              <div
                className="absolute bottom-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 text-[10px] font-mono px-2 py-1 rounded-base border-2 border-border bg-background shadow-shadow"
                style={{ pointerEvents: "auto" }}
              >
                <span className="opacity-60">label as</span>
                <select
                  value={labelClass}
                  onChange={(e) => setLabelClass(e.target.value)}
                  className="border-2 border-border rounded-base bg-secondary-background px-1.5 py-0.5"
                  style={{ color: `rgb(${(DEFECT_COLORS[labelClass] ?? [128, 128, 128]).join(",")})` }}
                >
                  {Object.keys(DEFECT_COLORS).map((cls) => (
                    <option key={cls} value={cls}>{cls}</option>
                  ))}
                </select>
                <button
                  onClick={() => void submitLabel()}
                  disabled={labelBusy}
                  className="px-2 py-0.5 rounded-base border-2 border-border bg-main text-main-foreground disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => setLabelPending(null)}
                  className="px-1.5 opacity-60 hover:opacity-100"
                >
                  cancel
                </button>
              </div>
            )}
            {labeling && labelMsg && (
              <div
                className="absolute top-2 left-1/2 -translate-x-1/2 z-40 px-2 py-0.5 rounded-base border-2 border-border bg-green-400 text-black text-[10px] font-heading shadow-shadow"
                style={{ pointerEvents: "none" }}
              >
                {labelMsg}
              </div>
            )}
            {/* objects-on-layer chip disabled for now — it sat over the
                bottom-left align handle and intercepted the drag.
                Re-enable with pointer-events-none (or move it into the
                card header) once the align workflow settles. */}
            {/* {showObjects && plotterObjects && plotterObjects.objects.length > 0 && (
              <span className="absolute bottom-1 left-1 text-[10px] font-mono px-1 rounded bg-black/60 text-white">
                {plotterObjects.objects.length} object{plotterObjects.objects.length === 1 ? "" : "s"} on layer
                {" · "}click to exclude
              </span>
            )} */}
          </div>
        </div>
      </CardContent>
      {pendingExclude && (
        <ConfirmModal
          obj={pendingExclude.obj}
          action={pendingExclude.action}
          busy={excludeBusy}
          error={excludeError}
          onConfirm={onConfirmExclude}
          onCancel={() => {
            if (excludeBusy) return;
            setPendingExclude(null);
            setExcludeError(null);
          }}
        />
      )}
    </Card>
  );
}

export function MissionControl({ job }: { job: JobStatus | null }) {
  // The agent chat console (PanelConsole) was pulled out of Mission Control
  // 2026-07-18 — to be reintroduced later if it earns its place. With the
  // chat gone the page needs no draggable split or wide/narrow layout swap:
  // one operator watch surface at every width — the job/status card on top,
  // the chamber feed filling the rest.
  return (
    <div className="h-full min-h-0 p-2 flex flex-col gap-2">
      <div className="min-h-0 overflow-y-auto">
        <JobPanel job={job} />
      </div>
      <div className="flex-1 min-h-0 grid">
        <ChamberThermalPane phase={job?.phase ?? null} />
      </div>
    </div>
  );
}
