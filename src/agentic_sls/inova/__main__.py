"""CLI: `python -m agentic_sls.inova` — start the HTTP monitor for the Inova MK1.

Polls /api/status and the chamber camera at a fixed interval, appending one
NDJSON line per poll and one JPEG per frame under `<project>/builds/`.
Auto-resumes from the next frame number if existing JPEGs are found.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from agentic_sls.inova.http import (
    DEFAULT_BASE_URL,
    default_builds_dir,
    monitor,
)
from agentic_sls.inova.videocamera import CLIENT_UUID


def _next_c(out_dir: Path, client_uuid: str) -> int:
    image_dir = out_dir / "images" / client_uuid
    if not image_dir.exists():
        return 0
    nums = [int(p.stem) for p in image_dir.glob("*.jpg") if p.stem.isdigit()]
    return max(nums) + 1 if nums else 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="agentic_sls.inova",
        description="Monitor the Inova MK1 (status + chamber camera).",
    )
    ap.add_argument("--interval", type=float, default=1.0,
                    help="seconds between polls (default: 1)")
    ap.add_argument("--uuid", default=CLIENT_UUID,
                    help="videocamera client UUID (default: per-process uuid4); "
                         "pass an existing UUID to resume that session's image dir")
    ap.add_argument("--url", default=DEFAULT_BASE_URL,
                    help=f"printer base URL (default: {DEFAULT_BASE_URL})")
    ap.add_argument("--out-dir", type=Path, default=None,
                    help="output dir (default: <project>/builds/)")
    ap.add_argument("--start-c", type=int, default=None,
                    help="starting frame counter (default: auto-resume from existing JPEGs)")
    args = ap.parse_args()

    out_dir = args.out_dir if args.out_dir is not None else default_builds_dir()
    start_c = args.start_c if args.start_c is not None else _next_c(out_dir, args.uuid)

    print(
        f"monitor: url={args.url} uuid={args.uuid} interval={args.interval}s "
        f"start_c={start_c} out_dir={out_dir}",
        file=sys.stderr, flush=True,
    )

    try:
        for event in monitor(
            out_dir=out_dir,
            client_uuid=args.uuid,
            interval=args.interval,
            base_url=args.url,
            start_c=start_c,
        ):
            is_printing = event.get("status", {}).get("isPrinting")
            print(
                f"poll #{event['c']:>5}  isPrinting={is_printing}  "
                f"img={event.get('image_bytes')}B",
                file=sys.stderr, flush=True,
            )
    except KeyboardInterrupt:
        print("\nstopped.", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
