"""Batch-backfill historical builds' frames into the Telemetry dataset.

Drives sls-deliver-frames across the builds still sitting in the local
frame buffer (data/frames/<id>), oldest build id first, committing each
build in the dataset repo as its own commit (zips + frames index). Push
remains manual — batch size is really "how much you want to upload next".

A build counts as delivered when the dataset already has its
data/frames_index/<NNN>.parquet (the last artifact deliver_build writes).
Already-delivered builds are skipped, so re-runs continue where the last
batch stopped. Originals are NEVER deleted here — that stays a manual,
post-HF-push-verification step (see wiki/Source-Based-Dataset-Layout.md).

Usage:
  uv run sls-backfill-frames --limit 3            # deliver+commit next 3
  uv run sls-backfill-frames --limit 1 --no-commit
  uv run sls-backfill-frames --builds 13,14       # explicit set, in order
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from agentic_sls.pipeline.deliver_frames import CHUNK_SIZE, deliver_build

REPO = Path(__file__).resolve().parent.parent.parent.parent.parent


def buffered_builds(frames_dir: Path) -> list[int]:
    out = []
    for p in frames_dir.iterdir():
        if p.is_dir() and p.name.isdigit() and any(p.iterdir()):
            out.append(int(p.name))
    return sorted(out)


def is_delivered(dataset: Path, build_id: int) -> bool:
    return (dataset / "data" / "frames_index" / f"{build_id:03d}.parquet").exists()


def commit_build(dataset: Path, build_id: int) -> None:
    """Retries transient index.lock races — a concurrent `git push` (LFS
    pre-push hooks) can hold the lock momentarily (bit us mid-backfill
    2026-07-16 while an upload ran)."""
    import time
    tag = f"{build_id:03d}"
    for cmd in (
        ["git", "-C", str(dataset), "add",
         f"source/frames/{tag}", f"data/frames_index/{tag}.parquet"],
        ["git", "-C", str(dataset), "commit", "-q", "-m",
         f"Add build {tag} source frames (chunked store-mode zips) + frames index"],
    ):
        for attempt in range(5):
            try:
                subprocess.run(cmd, check=True)
                break
            except subprocess.CalledProcessError:
                if attempt == 4:
                    raise
                time.sleep(3 * (attempt + 1))


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Deliver + commit the next batch of buffered builds.")
    ap.add_argument("--limit", type=int, default=1,
                    help="max builds this run (default 1)")
    ap.add_argument("--builds", type=str, default=None,
                    help="comma-separated explicit build ids (overrides discovery)")
    ap.add_argument("--frames-dir", type=Path, default=REPO / "data" / "frames")
    ap.add_argument("--dataset", type=Path,
                    default=REPO / "datasets" / "Agentic-SLS-Telemetry")
    ap.add_argument("--chunk-size", type=int, default=CHUNK_SIZE)
    ap.add_argument("--no-commit", action="store_true",
                    help="deliver only; leave the dataset working tree dirty")
    args = ap.parse_args()

    if args.builds:
        candidates = [int(b) for b in args.builds.split(",")]
    else:
        candidates = buffered_builds(args.frames_dir)

    todo = [b for b in candidates if not is_delivered(args.dataset, b)]
    skipped = [b for b in candidates if b not in todo]
    if skipped:
        print(f"already delivered, skipping: {skipped}")
    if not todo:
        print("nothing to do — all buffered builds are delivered")
        return 0

    batch = todo[: max(args.limit, 0)] if not args.builds else todo
    print(f"batch: {batch} (remaining after this run: {len(todo) - len(batch)})")

    for b in batch:
        rc = deliver_build(b, args.frames_dir, args.dataset,
                           args.chunk_size, force=False)
        if rc != 0:
            print(f"build {b}: delivery FAILED — stopping batch", file=sys.stderr)
            return rc
        if not args.no_commit:
            commit_build(args.dataset, b)
            print(f"build {b}: committed in dataset repo")

    remaining = [b for b in candidates if not is_delivered(args.dataset, b)]
    print(f"batch done. {len(remaining)} buffered build(s) still undelivered: "
          f"{remaining if remaining else '—'}")
    if not args.no_commit:
        print("push when ready: git -C datasets/Agentic-SLS-Telemetry push")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
