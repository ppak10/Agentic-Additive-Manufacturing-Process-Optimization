"""Post-build anomaly triage: scan a build's chamber frames with simple CV
and queue suspicious regions into anomaly_candidates for the GUI's
Labeling page. The machine only SORTS BY SUSPICION — every label decision
stays human.

Scope deliberately narrow (user, 2026-07-16):
  - Layers phase only (heating / bed prep / print cap / cooling excluded —
    the failure modes that matter happen while parts are being rastered)
  - POWDER region only: the bed quad from the operator homography minus
    the layer's part outlines (dilated). Scan marks inside parts are
    normal; debris/streaks on fresh powder are what we hunt.

Detectors (per sampled frame):
  diff    — |frame − same-slot frame of the previous layer| on the masked
            powder; powder should look identical layer over layer
  chroma  — HSV saturation on the masked powder; clean powder is gray,
            debris and streak discoloration carry color

Frames sampled per layer window (from layer_objects event boundaries):
first / middle / last — post-recoat and post-scan views without scoring
all ~500 frames a layer produces.

Usage:
  uv run sls-analyze-build --build 47 [--reset] [--max-per-frame 5]
Requires: frames on local disk (data/frames/<build>/...), layer_objects
events (builds 47+), and a plotter_to_camera calibration.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import psycopg

from agentic_sls.pipeline.backfill_camera_bboxes import inverse_projector, projector

REPO = Path(__file__).resolve().parent.parent.parent.parent.parent
FRAMES_DIR = REPO / "data" / "frames"

MIN_AREA_PX = 60        # connected-component floor (650x600 frame px)
DIFF_THRESH = 28        # absdiff threshold (0-255 gray)
SAT_THRESH = 70         # HSV saturation threshold (0-255)
PART_DILATE_PX = 12     # safety margin around part outlines
MIN_BRIGHTNESS = 60     # mean gray floor — skip scan-time frames where the
                        # halogens are dimmed and only the laser glows (they
                        # flooded the first triage queue with laser-glow
                        # chroma boxes; user feedback 2026-07-16)


def build_powder_mask(shape, project, objects) -> np.ndarray:
    """Bed quad minus dilated part outline polygons, in frame pixels."""
    h, w = shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    bed = np.array(
        [[project(u, v) for u, v in [(0, 0), (1, 0), (1, 1), (0, 1)]]], dtype=np.float64
    )
    bed_px = (bed * [w, h]).astype(np.int32)
    cv2.fillPoly(mask, bed_px, 255)
    parts = np.zeros((h, w), dtype=np.uint8)
    for o in objects or []:
        outline = o.get("outline")
        if not isinstance(outline, list) or len(outline) < 3:
            continue
        pts = np.array(
            [[project(p[0], p[1]) for p in outline if isinstance(p, list) and len(p) >= 2]],
            dtype=np.float64,
        )
        cv2.fillPoly(parts, (pts * [w, h]).astype(np.int32), 255)
    if PART_DILATE_PX > 0:
        parts = cv2.dilate(parts, np.ones((PART_DILATE_PX, PART_DILATE_PX), np.uint8))
    mask[parts > 0] = 0
    return mask


def galvo_remap_lut(quad, k1, cam_w=650, cam_h=600):
    """Per-pixel frame→plotter lookup (normalized), for warping galvo plot
    masks into chamber-frame space on legacy builds without layer_objects."""
    inv = inverse_projector(quad, k1)
    map_u = np.full((cam_h, cam_w), -1.0, np.float32)
    map_v = np.full((cam_h, cam_w), -1.0, np.float32)
    for y in range(cam_h):
        ny = (y + 0.5) / cam_h
        for x in range(cam_w):
            u, v = inv((x + 0.5) / cam_w, ny)
            if 0 <= u < 1 and 0 <= v < 1:
                map_u[y, x] = u
                map_v[y, x] = v
    return map_u, map_v


def galvo_scan_mask(galvo_img, map_u, map_v, shape):
    """Lit galvo pixels (planned gray + scanned white + laser) dilated and
    warped into frame space — the legacy stand-in for part outlines."""
    lit = (galvo_img.sum(axis=2) > 150).astype(np.uint8) * 255
    lit = cv2.dilate(lit, np.ones((7, 7), np.uint8))
    gh, gw = lit.shape
    mx = np.where(map_u >= 0, map_u * gw, -1).astype(np.float32)
    my = np.where(map_v >= 0, map_v * gh, -1).astype(np.float32)
    warped = cv2.remap(lit, mx, my, cv2.INTER_NEAREST,
                       borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    h, w = shape[:2]
    if warped.shape != (h, w):
        warped = cv2.resize(warped, (w, h), interpolation=cv2.INTER_NEAREST)
    return warped


def regions(binary: np.ndarray, score_img: np.ndarray, max_out: int):
    """Connected components → [(bbox_norm, score)] sorted by score."""
    h, w = binary.shape
    n, cc, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < MIN_AREA_PX:
            continue
        comp = cc[y:y + bh, x:x + bw] == i
        score = float(score_img[y:y + bh, x:x + bw][comp].mean()) / 255.0
        out.append(([x / w, y / h, (x + bw) / w, (y + bh) / h], score))
    out.sort(key=lambda r: -r[1])
    return out[:max_out]


def analyze_frame(img, prev_img, mask, max_per_frame):
    cands = []
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if prev_img is not None:
        prev_gray = cv2.cvtColor(prev_img, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(gray, prev_gray)
        diff[mask == 0] = 0
        # halogen pulsing shifts illumination globally between layers and
        # floods the diff everywhere — subtract the powder-region median so
        # only LOCAL change survives (build 47 shakedown: 17k candidates
        # before this fix, ~1k after)
        powder = diff[mask > 0]
        if powder.size > 0:
            diff = cv2.subtract(diff, int(np.median(powder)))
        binary = (diff > DIFF_THRESH).astype(np.uint8) * 255
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        cands += [(b, s, "diff") for b, s in regions(binary, diff, max_per_frame)]
    sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 1]
    sat[mask == 0] = 0
    # warm halogen light saturates the WHOLE bed — threshold saturation
    # relative to the powder median so only locally-more-colorful spots
    # (debris, scorch, streak discoloration) flag, not the lighting
    powder_sat = sat[mask > 0]
    if powder_sat.size > 0:
        sat = cv2.subtract(sat, int(np.median(powder_sat)))
    binary = (sat > SAT_THRESH).astype(np.uint8) * 255
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cands += [(b, s, "chroma") for b, s in regions(binary, sat, max_per_frame)]
    # dedupe overlapping diff/chroma boxes (keep higher score)
    kept = []
    for bbox, score, method in sorted(cands, key=lambda c: -c[1]):
        if any(_iou(bbox, k[0]) > 0.5 for k in kept):
            continue
        kept.append((bbox, score, method))
    return kept[:max_per_frame]


def _iou(a, b) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    area = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / area if area > 0 else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=int, required=True)
    parser.add_argument("--max-per-frame", type=int, default=5)
    parser.add_argument("--top-frames", type=int, default=250,
                        help="keep only the N most suspicious frames per run")
    parser.add_argument("--min-score", type=float, default=0.25)
    parser.add_argument("--min-brightness", type=float, default=MIN_BRIGHTNESS,
                        help="mean-gray floor for a frame to be analyzed")
    parser.add_argument("--reset", action="store_true",
                        help="delete this build's PENDING candidates first")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = parser.parse_args()

    if not args.dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT payload FROM calibrations WHERE kind='plotter_to_camera' ORDER BY id DESC LIMIT 1"
        )
        row = cur.fetchone()
        if not row:
            print("no plotter_to_camera calibration", file=sys.stderr)
            return 1
        project = projector(row[0]["quad"], float(row[0].get("k1") or 0))

        # Layers-phase window from phase_change events
        cur.execute(
            """SELECT ts, message FROM events
               WHERE build_id=%s AND kind='phase_change' ORDER BY ts""",
            (args.build,),
        )
        t_start = t_end = None
        for ts, message in cur.fetchall():
            if message and message.endswith("→ Layers"):
                t_start = ts
            elif message and message.startswith("Layers →"):
                t_end = ts
        if t_start is None:
            # Recorder joined mid-build: no "→ Layers" entry event was recorded.
            # If we at least have the exit ("Layers → …"), derive the Layers
            # start from the first z2 layer-step before it — z2 (the build
            # piston) only steps during Layers, so its first step marks the real
            # start and keeps heating/bed-prep frames out of the window.
            if t_end is None:
                print("no Layers phase found for this build", file=sys.stderr)
                return 1
            cur.execute(
                """SELECT ts, value FROM telemetry
                   WHERE build_id=%s AND kind='position.z2' AND ts <= %s
                   ORDER BY ts""",
                (args.build, t_end),
            )
            prev_v = None
            for ts, value in cur.fetchall():
                if prev_v is not None and value > prev_v:
                    t_start = ts
                    break
                prev_v = value
            if t_start is None:
                print("no Layers phase found (no z2 steps before exit)", file=sys.stderr)
                return 1
            print(f"no '→ Layers' event; derived t_start from first z2 step: {t_start}")

        cur.execute(
            """SELECT ts, payload->'objects' FROM events
               WHERE build_id=%s AND kind='layer_objects' AND ts >= %s
                 AND (%s::timestamptz IS NULL OR ts <= %s)
               ORDER BY ts""",
            (args.build, t_start, t_end, t_end),
        )
        layers = [(ts, objs or []) for ts, objs in cur.fetchall()]
        legacy = not layers
        galvo_frames: list = []
        lut = None
        if legacy:
            # LEGACY BUILDS (pre-47, no layer_objects): layer clock from z2
            # steps in telemetry; part mask reconstructed from the galvo
            # plot images (the plot IS the part area, in plotter space).
            print("legacy mode: layer windows from z2, part masks from galvo plots")
            cur.execute(
                """SELECT ts, value FROM telemetry
                   WHERE build_id=%s AND kind='position.z2' AND ts >= %s
                     AND (%s::timestamptz IS NULL OR ts <= %s)
                   ORDER BY ts""",
                (args.build, t_start, t_end, t_end),
            )
            prev_v = None
            bounds = []
            for ts, value in cur.fetchall():
                if prev_v is not None and value > prev_v:
                    bounds.append(ts)
                prev_v = value
            layers = [(ts, None) for ts in bounds]
            print(f"z2 layer boundaries: {len(layers)}")
            cur.execute(
                """SELECT id, ts, path FROM frames
                   WHERE build_id=%s AND kind='galvo' AND ts >= %s
                     AND (%s::timestamptz IS NULL OR ts <= %s)
                   ORDER BY ts""",
                (args.build, t_start, t_end, t_end),
            )
            galvo_frames = cur.fetchall()
            row_c = cur.connection.cursor()
            row_c.execute(
                "SELECT payload FROM calibrations WHERE kind='plotter_to_camera' ORDER BY id DESC LIMIT 1")
            calib = row_c.fetchone()[0]
            print("building frame→plotter LUT…")
            lut = galvo_remap_lut(calib["quad"], float(calib.get("k1") or 0))
        if not layers:
            print("no layer windows derivable for this build", file=sys.stderr)
            return 1

        cur.execute(
            """SELECT id, ts, path FROM frames
               WHERE build_id=%s AND kind='chamber' AND ts >= %s
                 AND (%s::timestamptz IS NULL OR ts <= %s)
               ORDER BY ts""",
            (args.build, t_start, t_end, t_end),
        )
        frames = cur.fetchall()
        print(f"layers: {len(layers)} | chamber frames in Layers phase: {len(frames)}")

        if args.reset:
            cur.execute(
                "DELETE FROM anomaly_candidates WHERE build_id=%s AND status='pending'",
                (args.build,),
            )
            print(f"reset: {cur.rowcount} pending candidates removed")

        # per layer window: sample first / middle / last frame
        total = 0
        prev_samples: list = [None, None, None]
        fi = 0
        for li, (lts, objects) in enumerate(layers):
            next_ts = layers[li + 1][0] if li + 1 < len(layers) else None
            window = []
            while fi < len(frames) and (next_ts is None or frames[fi][1] < next_ts):
                if frames[fi][1] >= lts:
                    window.append(frames[fi])
                fi += 1
            if not window:
                continue
            # brightness-gated sampling: stride through the window, keep
            # only well-lit frames (powder visible), then take first /
            # middle / last of the LIT subset
            stride = max(1, len(window) // 12)
            lit = []
            for cand in window[::stride]:
                img = cv2.imread(str(FRAMES_DIR / cand[2]))
                if img is not None and float(img.mean()) >= args.min_brightness:
                    lit.append((cand, img))
                if len(lit) >= 12:
                    break
            if not lit:
                prev_samples = [None, None, None]
                continue
            picks = [lit[0], lit[len(lit) // 2], lit[-1]]
            mask = None
            legacy_scan = None
            if legacy and lut is not None:
                # last galvo of the window = the layer's full plot
                gwin = [g for g in galvo_frames if lts <= g[1] and (next_ts is None or g[1] < next_ts)]
                if gwin:
                    gimg = cv2.imread(str(FRAMES_DIR / gwin[-1][2]))
                    if gimg is not None:
                        legacy_scan = (gimg, lut)
            new_prev: list = [None, None, None]
            for slot, ((frame_id, fts, path), img) in enumerate(picks):
                new_prev[slot] = img
                if img is None:
                    continue
                if mask is None:
                    if legacy:
                        mask = build_powder_mask(img.shape, project, [])
                        if legacy_scan is not None:
                            warped = galvo_scan_mask(legacy_scan[0], legacy_scan[1][0], legacy_scan[1][1], img.shape)
                            mask[warped > 0] = 0
                    else:
                        mask = build_powder_mask(img.shape, project, objects)
                for bbox, score, method in analyze_frame(
                    img, prev_samples[slot], mask, args.max_per_frame
                ):
                    cur.execute(
                        """INSERT INTO anomaly_candidates
                             (build_id, layer, frame_id, ts, bbox, score, method)
                           VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                        (args.build, li + 1, frame_id, fts, bbox, score, method),
                    )
                    total += 1
            prev_samples = new_prev
            if (li + 1) % 25 == 0:
                conn.commit()
                print(f"  layer {li + 1}/{len(layers)} — {total} candidates so far")
        conn.commit()
        # triage-size the queue: keep the --top-frames most suspicious
        # frames, drop sub-floor regions within them. The point is a queue
        # a human can clear, not a complete inventory of pixels that moved.
        cur.execute(
            """WITH ranked AS (
                 SELECT frame_id, max(score) AS mx FROM anomaly_candidates
                 WHERE build_id=%s AND status='pending' GROUP BY frame_id
                 ORDER BY mx DESC LIMIT %s
               )
               DELETE FROM anomaly_candidates a
               WHERE a.build_id=%s AND a.status='pending'
                 AND (a.frame_id NOT IN (SELECT frame_id FROM ranked)
                      OR a.score < %s)""",
            (args.build, args.top_frames, args.build, args.min_score),
        )
        pruned = cur.rowcount
        conn.commit()
        cur.execute(
            """SELECT count(*), count(DISTINCT frame_id) FROM anomaly_candidates
               WHERE build_id=%s AND status='pending'""",
            (args.build,),
        )
        kept, kept_frames = cur.fetchone()
        print(f"done: {total} raw candidates → pruned {pruned} → queue: "
              f"{kept} regions across {kept_frames} frames (build {args.build})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
