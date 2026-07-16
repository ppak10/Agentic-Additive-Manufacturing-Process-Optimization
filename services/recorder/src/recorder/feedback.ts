// Operator-feedback + build-layout capture (2026-07-16). Records the
// human's override/exclusion decisions as events rows so the exported
// telemetry carries input labels: WHAT was done, to WHICH part, WHERE it
// sits on the bed, and WHAT the printer context was (phase, z2, latest
// defect verdict). Association with chamber/thermal/galvo imagery is by
// timestamp — the ticks parquet already embeds tick-aligned frames.
//
// Three event kinds:
//   operator_action — one row per successful override POST through the
//     GUI proxies (agent MCP calls are logged separately in agent_actions).
//   build_layout    — full parts array (transforms + bounds + exclusion
//     state) once per build and again on every exclusion change.
//   layer_objects   — the plotter's per-layer object set, recorded on
//     version change: which parts are rastered on the current layer and
//     their outlines in the plotter workspace.

import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { currentBuildId, isShuttingDown } from "./state.js";
import { getLatestSnapshot } from "./telemetry.js";
import { getLatestPrintingStatus } from "./job.js";

// Firmware calibration constants (sls4all/SLS4All-Backup/Current/
// appsettings*.toml, retrieved 2026-07-16), recorded verbatim into every
// build_layout event so bbox → chamber-px → thermal-cell projection stays
// reproducible even if the constants change later. Coordinates in parts/
// layer objects are NEVER pre-transformed — always native spaces plus
// this block.
const CAM_W = 650, CAM_H = 600;

// Operator-measured plotter→camera projection (Mission Control's Align
// mode). Authoritative source: the calibrations table (latest
// 'plotter_to_camera' row; the web POSTs there on every align save),
// refreshed into a module cache by the layout recorder's loop; repo .env
// (VITE_PLOTTER_QUAD/VITE_PLOTTER_FISHEYE) is the bootstrap fallback.
// quad = the plotter unit square's corners in normalized image coords,
// order (0,0)(1,0)(1,1)(0,1); k1 = radial fisheye term, corners-pinned.
// Null until calibrated — then every build_layout event carries it and
// layer_objects gain derived camera-space bboxes.
type Quad = [number, number][];
let dbCalib: { quad: Quad; k1: number } | null = null;

export async function refreshCalibration(): Promise<void> {
  try {
    const { rows } = await pool.query<{ payload: { quad?: unknown; k1?: unknown } }>(
      `SELECT payload FROM calibrations WHERE kind = 'plotter_to_camera'
       ORDER BY id DESC LIMIT 1`,
    );
    const p = rows[0]?.payload;
    if (Array.isArray(p?.quad) && p.quad.length === 4) {
      dbCalib = { quad: p.quad as Quad, k1: Number(p.k1) || 0 };
    }
  } catch { /* table may not exist on first boot — env fallback covers it */ }
}

function plotterToCamera(): { quad: Quad; k1: number } | null {
  if (dbCalib) return dbCalib;
  try {
    const quad = JSON.parse(process.env.VITE_PLOTTER_QUAD ?? "");
    if (Array.isArray(quad) && quad.length === 4) {
      return { quad: quad as Quad, k1: Number(process.env.VITE_PLOTTER_FISHEYE) || 0 };
    }
  } catch { /* unset or malformed — omit */ }
  return null;
}

// Mirror of the web overlay's projection (MissionControl.tsx): Heckbert
// square→quad homography, then a radial term normalized at the quad
// corners' mean radius (aspect-corrected). Keep the two in sync.
function projector(q: Quad, k1: number): (u: number, v: number) => [number, number] {
  const [[x1, y1], [x2, y2], [x3, y3], [x4, y4]] = q as [number, number][] &
    [[number, number], [number, number], [number, number], [number, number]];
  const dx1 = x2 - x3, dx2 = x4 - x3, dx3 = x1 - x2 + x3 - x4;
  const dy1 = y2 - y3, dy2 = y4 - y3, dy3 = y1 - y2 + y3 - y4;
  let g = 0, h = 0;
  const den = dx1 * dy2 - dy1 * dx2;
  if ((dx3 !== 0 || dy3 !== 0) && den !== 0) {
    g = (dx3 * dy2 - dy3 * dx2) / den;
    h = (dx1 * dy3 - dy1 * dx3) / den;
  }
  const a = x2 - x1 + g * x2, b = x4 - x1 + h * x4, c = x1;
  const d = y2 - y1 + g * y2, e = y4 - y1 + h * y4, f = y1;
  const A = CAM_W / CAM_H;
  const r2 = (x: number, y: number) => {
    const dx = (x - 0.5) * A, dy = y - 0.5;
    return dx * dx + dy * dy;
  };
  const rref = q.reduce((s, [x, y]) => s + r2(x!, y!), 0) / 4;
  return (u, v) => {
    const w = g * u + h * v + 1;
    const x = (a * u + b * v + c) / w;
    const y = (d * u + e * v + f) / w;
    if (k1 === 0) return [x, y];
    const m = (1 + k1 * r2(x, y)) / (1 + k1 * rref);
    return [0.5 + (x - 0.5) * m, 0.5 + (y - 0.5) * m];
  };
}

// Per-object camera-space bbox [x0, y0, x1, y1] in normalized image
// coords, derived from the plotter outline through the measured
// projection. Null when uncalibrated.
function cameraBboxes(
  objects: { id?: unknown; outline?: unknown }[],
): Record<string, [number, number, number, number]> | null {
  const calib = plotterToCamera();
  if (!calib) return null;
  const P = projector(calib.quad, calib.k1);
  const out: Record<string, [number, number, number, number]> = {};
  for (const o of objects) {
    if (o.id == null || !Array.isArray(o.outline)) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pt of o.outline as [number, number][]) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const [x, y] = P(pt[0]!, pt[1]!);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (x0 <= x1) out[String(o.id)] = [x0, y0, x1, y1];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function getCalibration() {
  return {
    camera: { frame: [CAM_W, CAM_H], safe_working_area: { x: [105, 545], y: [113, 547] } },
    thermal: { matrix: [32, 24], main_box: { x: [10, 24], y: [9, 23] } },
    // measured projection wins over the nominal rect for spatial joins
    plotter_to_camera: plotterToCamera()
      ? { ...plotterToCamera(), model: "heckbert-homography + radial k1, corners-pinned, aspect-corrected" }
      : null,
    source:
      "MjpegDeviceCamera.SafeWorkingArea + Mlx90640Camera.MainBox (appsettings); plotter_to_camera operator-aligned (Mission Control)",
  };
}

type PrintingObject = {
  id: number;
  name: string;
  hash: string;
  transform: number[][];
  bounds: { center: number[]; size: number[] };
  isExcluded: boolean;
};

type PlotterObjects = {
  version: number;
  width: number;
  height: number;
  objects: unknown[];
};

// Plugin responses arrive in a { respondedAt, data } envelope.
async function plugin<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${config.INOVA_API_BASE_URL}${path}`);
    if (!r.ok) return null;
    const env = (await r.json()) as { data?: T };
    return env.data ?? null;
  } catch {
    return null;
  }
}

function printContext() {
  const snap = getLatestSnapshot();
  const ps = getLatestPrintingStatus();
  return {
    z2: snap?.data.position.z2 ?? null,
    phase: ps?.phase ?? null,
    progress: ps?.progress ?? null,
    job_name: ps?.jobName ?? null,
  };
}

// The stimulus link: the most recent defect verdict the operator could
// have been reacting to. 15 min covers slow deliberation without pulling
// in stale verdicts from hours earlier.
async function latestDefectEvent(buildId: number) {
  const { rows } = await pool.query<{ id: string; ts: Date; message: string | null; alerts: unknown }>(
    `SELECT id, ts, message, payload->'alerts' AS alerts FROM events
     WHERE build_id = $1 AND kind = 'defect_detection' AND ts > now() - interval '15 minutes'
     ORDER BY ts DESC LIMIT 1`,
    [buildId],
  );
  const r = rows[0];
  return r ? { event_id: Number(r.id), ts: r.ts, message: r.message, alerts: r.alerts } : null;
}

async function writeBuildLayout(
  buildId: number | null,
  objects: PrintingObject[] | null,
  reason: string,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const parts = objects ?? (await plugin<{ objects: PrintingObject[] }>("/printing/objects"))?.objects ?? null;
  if (!parts) return false;
  const plot = await plugin<PlotterObjects>("/plotter/objects");
  try {
    await pool.query(
      `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, 'build_layout', $2, $3)`,
      [
        buildId,
        `${parts.length} parts, ${parts.filter((p) => p.isExcluded).length} excluded (${reason})`,
        JSON.stringify({
          reason,
          parts,
          plotter_workspace: plot ? { version: plot.version, width: plot.width, height: plot.height } : null,
          calibration: getCalibration(),
          context: printContext(),
        }),
      ],
    );
    return true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "build_layout event insert failed");
    return false;
  }
}

// Called fire-and-forget from the override POST proxies AFTER upstream
// success — recording must never delay or fail the operator's action.
export async function recordOperatorAction(
  action: string,
  params: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<void> {
  if (isShuttingDown()) return;
  const buildId = currentBuildId();
  const payload: Record<string, unknown> = {
    source: "gui",
    action,
    params,
    context: printContext(),
  };
  try {
    if (buildId != null) {
      const stimulus = await latestDefectEvent(buildId);
      if (stimulus) payload.stimulus_defect_event = stimulus;
    }
    if (action === "exclude_part") {
      const objs = (await plugin<{ objects: PrintingObject[] }>("/printing/objects"))?.objects ?? null;
      const part = objs?.find((o) => o.id === params.object_id);
      if (part) payload.part = part;
      // an exclusion changes the layout — snapshot the new state alongside
      await writeBuildLayout(buildId, objs, "exclusion change", log);
    }
    await pool.query(
      `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, 'operator_action', $2, $3)`,
      [buildId, `operator: ${action} ${JSON.stringify(params)}`, JSON.stringify(payload)],
    );
    log.info({ action, buildId }, "operator action recorded");
  } catch (err) {
    log.warn({ err: (err as Error).message, action }, "operator action record failed");
  }
}

export function startLayoutRecorder(log: FastifyBaseLogger): void {
  let layoutForBuild: number | null = null;
  let lastPlotVersion: number | null = null;

  void refreshCalibration();
  let calibTick = 0;
  void (async () => {
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      if (isShuttingDown()) continue;
      // re-read the calibration every ~30 s so an operator re-align
      // propagates without a recorder restart
      if (++calibTick % 15 === 0) void refreshCalibration();
      const buildId = currentBuildId();
      if (buildId == null) {
        layoutForBuild = null;
        lastPlotVersion = null;
        continue;
      }
      // One layout snapshot per build (retries next tick until it lands —
      // the plugin may be briefly unreachable right at adoption time).
      if (layoutForBuild !== buildId) {
        const ok = await writeBuildLayout(buildId, null, "build start", log);
        if (ok) {
          layoutForBuild = buildId;
          log.info({ buildId }, "build_layout snapshot recorded");
        }
        continue;
      }
      const plot = await plugin<PlotterObjects>("/plotter/objects");
      if (!plot || plot.version === lastPlotVersion) continue;
      try {
        await pool.query(
          `INSERT INTO events (build_id, kind, message, payload) VALUES ($1, 'layer_objects', $2, $3)`,
          [
            buildId,
            `plot v${plot.version}: ${plot.objects.length} objects`,
            JSON.stringify({
              version: plot.version,
              width: plot.width,
              height: plot.height,
              objects: plot.objects,
              // derived spatial join: per-object bbox on the chamber image
              // (normalized coords) through the operator-measured
              // homography; null until calibrated. Native outlines above
              // stay untransformed.
              camera_bboxes: cameraBboxes(plot.objects as { id?: unknown; outline?: unknown }[]),
              context: printContext(),
            }),
          ],
        );
        lastPlotVersion = plot.version;
      } catch (err) {
        log.warn({ err: (err as Error).message }, "layer_objects event insert failed");
      }
    }
  })();
}
