"""Backfill derived camera-space bboxes into recorded layer_objects events.

layer_objects events recorded before the camera-bbox projection went live
(build 47's whole run — the recorder code shipped mid-print, dormant until
the post-print restart) have camera_bboxes: null. This recomputes them
from the NATIVE outlines through the operator-measured plotter→camera
calibration (calibrations table, kind='plotter_to_camera') and updates the
event payloads in place — so the values flow into the events.jsonl export
for the Telemetry dataset.

The projection is a Python port of the shared math (web lib/projection.ts,
recorder feedback.ts): Heckbert square→quad homography + corners-pinned
radial fisheye, aspect-corrected. Keep in sync.

Usage:
  uv run sls-backfill-camera-bboxes [--build 47] [--force]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg

CAM_W, CAM_H = 650, 600


def projector(quad: list[list[float]], k1: float):
    (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [tuple(c) for c in quad]
    dx1, dx2, dx3 = x2 - x3, x4 - x3, x1 - x2 + x3 - x4
    dy1, dy2, dy3 = y2 - y3, y4 - y3, y1 - y2 + y3 - y4
    g = h = 0.0
    den = dx1 * dy2 - dy1 * dx2
    if (dx3 != 0 or dy3 != 0) and den != 0:
        g = (dx3 * dy2 - dy3 * dx2) / den
        h = (dx1 * dy3 - dy1 * dx3) / den
    a, b, c = x2 - x1 + g * x2, x4 - x1 + h * x4, x1
    d, e, f = y2 - y1 + g * y2, y4 - y1 + h * y4, y1
    aspect = CAM_W / CAM_H

    def r2(x: float, y: float) -> float:
        dx, dy = (x - 0.5) * aspect, y - 0.5
        return dx * dx + dy * dy

    rref = sum(r2(x, y) for x, y in [tuple(q) for q in quad]) / 4

    def project(u: float, v: float) -> tuple[float, float]:
        w = g * u + h * v + 1
        x = (a * u + b * v + c) / w
        y = (d * u + e * v + f) / w
        if k1 == 0:
            return x, y
        m = (1 + k1 * r2(x, y)) / (1 + k1 * rref)
        return 0.5 + (x - 0.5) * m, 0.5 + (y - 0.5) * m

    return project


def inverse_projector(quad: list[list[float]], k1: float):
    """Inverse of projector(): normalized image coords -> plotter (u,v).
    Port of web lib/projection.ts inverseProjector — keep in sync."""
    (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [tuple(c) for c in quad]
    dx1, dx2, dx3 = x2 - x3, x4 - x3, x1 - x2 + x3 - x4
    dy1, dy2, dy3 = y2 - y3, y4 - y3, y1 - y2 + y3 - y4
    g = h = 0.0
    den = dx1 * dy2 - dy1 * dx2
    if (dx3 != 0 or dy3 != 0) and den != 0:
        g = (dx3 * dy2 - dy3 * dx2) / den
        h = (dx1 * dy3 - dy1 * dx3) / den
    a, b, c = x2 - x1 + g * x2, x4 - x1 + h * x4, x1
    d, e, f = y2 - y1 + g * y2, y4 - y1 + h * y4, y1
    det = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g)
    inv = [
        (e - f * h) / det, (c * h - b) / det, (b * f - c * e) / det,
        (f * g - d) / det, (a - c * g) / det, (c * d - a * f) / det,
        (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ]
    aspect = CAM_W / CAM_H

    def r2(x: float, y: float) -> float:
        dx, dy = (x - 0.5) * aspect, y - 0.5
        return dx * dx + dy * dy

    rref = sum(r2(x, y) for x, y in [tuple(q) for q in quad]) / 4

    def unproject(x: float, y: float) -> tuple[float, float]:
        ux, uy = x, y
        if k1 != 0:
            for _ in range(3):
                m = (1 + k1 * r2(ux, uy)) / (1 + k1 * rref)
                ux = 0.5 + (x - 0.5) / m
                uy = 0.5 + (y - 0.5) / m
        w = inv[6] * ux + inv[7] * uy + inv[8]
        return (
            (inv[0] * ux + inv[1] * uy + inv[2]) / w,
            (inv[3] * ux + inv[4] * uy + inv[5]) / w,
        )

    return unproject


def camera_bboxes(objects: list[dict], project) -> dict[str, list[float]] | None:
    out: dict[str, list[float]] = {}
    for o in objects:
        outline = o.get("outline")
        if o.get("id") is None or not isinstance(outline, list):
            continue
        xs, ys = [], []
        for pt in outline:
            if not isinstance(pt, list) or len(pt) < 2:
                continue
            x, y = project(pt[0], pt[1])
            xs.append(x)
            ys.append(y)
        if xs:
            out[str(o["id"])] = [min(xs), min(ys), max(xs), max(ys)]
    return out or None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=int, default=None)
    parser.add_argument("--force", action="store_true",
                        help="recompute even where camera_bboxes already exist")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = parser.parse_args()

    if not args.dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT payload FROM calibrations
               WHERE kind = 'plotter_to_camera' ORDER BY id DESC LIMIT 1""",
        )
        row = cur.fetchone()
        if not row or not isinstance(row[0].get("quad"), list):
            print("no plotter_to_camera calibration recorded", file=sys.stderr)
            return 1
        calib = row[0]
        project = projector(calib["quad"], float(calib.get("k1") or 0))

        where = "kind = 'layer_objects'"
        params: list[object] = []
        if not args.force:
            where += " AND (payload->'camera_bboxes' IS NULL OR payload->'camera_bboxes' = 'null'::jsonb)"
        if args.build is not None:
            where += " AND build_id = %s"
            params.append(args.build)

        cur.execute(f"SELECT id, payload FROM events WHERE {where} ORDER BY id", params)
        rows = cur.fetchall()
        print(f"{len(rows)} layer_objects events to backfill")

        updated = 0
        for event_id, payload in rows:
            bboxes = camera_bboxes(payload.get("objects") or [], project)
            cur.execute(
                """UPDATE events SET payload = jsonb_set(payload, '{camera_bboxes}', %s::jsonb)
                   WHERE id = %s""",
                (json.dumps(bboxes), event_id),
            )
            updated += 1
            if updated % 500 == 0:
                conn.commit()
                print(f"  {updated}/{len(rows)}")
        conn.commit()
        print(f"done: {updated} events updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
