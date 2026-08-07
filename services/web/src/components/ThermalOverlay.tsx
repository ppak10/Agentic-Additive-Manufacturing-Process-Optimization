import { useEffect, useMemo, useRef, useState } from "react";
import { useBedMatrix, type BedMatrixFrame } from "@/hooks/useBedMatrix";
import { plasma } from "@/lib/thermal";
import {
  CAM_W,
  CAM_H,
  homography,
  projector,
  loadCalib,
  QUAD_KEY,
  type Quad,
} from "@/lib/projection";

// Shared thermal-overlay pipeline (extracted from Mission Control 2026-07-27
// so the powder-tuning artifact panel renders the SAME bed-registered
// temperature grid). The thermal matrix is projected through PT = H∘T:
//   T: thermal grid → plotter uv (calibrations kind='thermal_to_plotter',
//      seeded flat from the Mlx90640 MainBox ↔ SafeWorkingArea mapping)
//   H: plotter uv → chamber image (operator-aligned quad + fisheye k1,
//      calibrations kind='plotter_to_camera', localStorage echo)
// Composing with H means the grid inherits the video camera's perspective +
// fisheye and every future re-align for free.

// Calibration comes from the FIRMWARE'S OWN config (sls4all/SLS4All-Backup/
// Current/appsettings*.toml, retrieved 2026-07-16):
//   Mlx90640Camera.MainBox (bed in thermal px, 32x24 sensor): x 10-24, y 9-23
export const BED_THERM = { sx: 10, sy: 9, sw: 15, sh: 15 }; // MainBox, inclusive
export const THERM_W = 32, THERM_H = 24;
// Operator-trimmed crop (2026-07-16): the leftmost 7 and rightmost 4 thermal
// columns, and the TOP 5 rows, fall outside the chamber view — drop them.
export const THERM_CROP = { sx: 7, sw: THERM_W - 7 - 4, sy: 5, sh: THERM_H - 5 };
// Flat seed for T from the MainBox correspondence; the DB row overrides.
export const THERMAL_T_SEED: Quad = [
  [(0 - BED_THERM.sx) / BED_THERM.sw, (0 - BED_THERM.sy) / BED_THERM.sh],
  [(THERM_W - BED_THERM.sx) / BED_THERM.sw, (0 - BED_THERM.sy) / BED_THERM.sh],
  [(THERM_W - BED_THERM.sx) / BED_THERM.sw, (THERM_H - BED_THERM.sy) / BED_THERM.sh],
  [(0 - BED_THERM.sx) / BED_THERM.sw, (THERM_H - BED_THERM.sy) / BED_THERM.sh],
];

// Chamber calibration (H): browser-local echo first, then adopt the
// calibrations-table row if it's newer — whoever aligned most recently wins,
// across machines. Returns setCalib so Mission Control's Align mode can keep
// dragging corners.
export function useChamberCalib() {
  const [calib, setCalib] = useState(loadCalib);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/calibration/plotter_to_camera");
        if (!r.ok) return; // endpoint not deployed yet, or no row
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
  return [calib, setCalib] as const;
}

// Thermal→plotter quad (T): flat MainBox seed, DB row overrides on load.
export function useThermalQuad(): Quad {
  const [thermQuad, setThermQuad] = useState<Quad>(THERMAL_T_SEED);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/calibration/thermal_to_plotter");
        if (!r.ok) return; // no row — seed stands
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
  return thermQuad;
}

// Compose PT from a thermal quad and the chamber projector H.
export function composePT(
  thermQuad: Quad,
  H: (u: number, v: number) => [number, number],
): (tx: number, ty: number) => [number, number] {
  const T = homography(thermQuad);
  return (tx, ty) => {
    const [u, v] = T(tx / THERM_W, ty / THERM_H);
    return H(u, v);
  };
}

// Per-cell temperature DIGITS, font-colored by the shared plasma palette
// (normalized over the visible crop). Every cell center and grid vertex is
// projected through PT so the grid follows the bed's perspective + fisheye
// exactly like the part vectors do. Dark halo via strokeText, NOT
// shadowBlur — canvas shadows janked the pane.
export function paintThermalOverlay(
  canvas: HTMLCanvasElement,
  frame: BedMatrixFrame,
  PT: (tx: number, ty: number) => [number, number],
): void {
  const { width, values } = frame.data;
  const S = 2; // supersample for crisp glyphs
  canvas.width = CAM_W * S;
  canvas.height = CAM_H * S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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
}

// Self-contained overlay for panes that don't run their own align mode
// (the powder-tuning artifact panel): opens the bedmatrix stream, loads both
// calibrations, and paints over the chamber image. Position inside a
// relative container that holds the chamber <img>; mount it conditionally —
// unmounting closes the bedmatrix WebSocket.
export function ThermalOverlay() {
  const { frame } = useBedMatrix();
  const [{ quad, k1 }] = useChamberCalib();
  const thermQuad = useThermalQuad();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const H = useMemo(() => projector(quad, k1), [quad, k1]);
  const PT = useMemo(() => composePT(thermQuad, H), [thermQuad, H]);
  useEffect(() => {
    if (!frame || !canvasRef.current) return;
    paintThermalOverlay(canvasRef.current, frame, PT);
  }, [frame, PT]);
  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}
