"""Deliver a build's frames into the Agentic-SLS-Telemetry dataset.

Implements the frames flow of wiki/Source-Based-Dataset-Layout.md
(settled 2026-07-15):

  source/frames/<NNN>/<kind>/chunk-0001.zip   store-mode archival originals
                                              at native capture rate,
                                              <= --chunk-size frames per zip
  data/frames_index/<NNN>.parquet             one row per frame:
                                              ts_ms, kind, archive, member,
                                              size_bytes

The ML-ready published form is the EXISTING ticks config — its parquet
already embeds tick-aligned frame_chamber/galvo/thermal images, the
bedmatrix matrix, and position bursts per 10 Hz row (verified 2026-07-15).
The zips add what ticks cannot: the complete native-rate originals (e.g.
chamber at ~20 fps vs the 10 Hz tick grid).

Idempotent: existing chunk zips with the expected member count are kept
(--force rewrites). Chunking is deterministic (sorted by timestamp then
name), so re-runs produce identical layouts. This tool never deletes the
buffered originals and never touches Postgres — deletion happens only
after HF push verification, and frames.path rewrites are a separate step.

Usage:
  uv run sls-deliver-frames --build 12
  uv run sls-deliver-frames --build 12 --frames-dir data/frames --force
"""

from __future__ import annotations

import argparse
import random
import re
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parent.parent.parent
FRAME_NAME = re.compile(r"^(\d+)[._]([A-Za-z0-9]+)\.([A-Za-z0-9]+)$")

CHUNK_SIZE = 10_000
SPOT_CHECKS_PER_ZIP = 5


@dataclass(frozen=True)
class Frame:
    path: Path
    ts_ms: int
    kind: str
    ext: str
    size: int


def scan_frames(build_dir: Path) -> dict[str, list[Frame]]:
    """Group the buffer dir's files by kind, sorted by (ts, name)."""
    by_kind: dict[str, list[Frame]] = {}
    skipped = 0
    for p in build_dir.iterdir():
        if not p.is_file():
            continue
        m = FRAME_NAME.match(p.name)
        if not m:
            skipped += 1
            continue
        f = Frame(p, int(m.group(1)), m.group(2).lower(), m.group(3).lower(),
                  p.stat().st_size)
        by_kind.setdefault(f.kind, []).append(f)
    for frames in by_kind.values():
        frames.sort(key=lambda f: (f.ts_ms, f.path.name))
    if skipped:
        print(f"  note: {skipped} files did not match <ts>_<kind>.<ext> — skipped")
    return by_kind


def chunked(frames: list[Frame], n: int) -> list[list[Frame]]:
    return [frames[i:i + n] for i in range(0, len(frames), n)]


def write_zip_chunks(
    frames: list[Frame], kind_dir: Path, chunk_size: int, force: bool,
) -> list[tuple[str, list[Frame]]]:
    """Write store-mode chunk zips; returns (archive relname, members)."""
    kind_dir.mkdir(parents=True, exist_ok=True)
    out: list[tuple[str, list[Frame]]] = []
    for i, chunk in enumerate(chunked(frames, chunk_size), start=1):
        name = f"chunk-{i:04d}.zip"
        zpath = kind_dir / name
        if zpath.exists() and not force:
            with zipfile.ZipFile(zpath) as z:
                if len(z.namelist()) == len(chunk):
                    out.append((name, chunk))
                    continue
            print(f"  {zpath.name}: exists with wrong member count — rewriting")
        with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_STORED) as z:
            for f in chunk:
                z.write(f.path, arcname=f.path.name)
        out.append((name, chunk))
    return out


def verify_zips(kind_dir: Path, chunks: list[tuple[str, list[Frame]]]) -> None:
    """Member counts + random byte-identity spot checks. Raises on mismatch."""
    rng = random.Random(0)  # deterministic — same spot checks every run
    for name, members in chunks:
        with zipfile.ZipFile(kind_dir / name) as z:
            names = z.namelist()
            if len(names) != len(members):
                raise RuntimeError(
                    f"{kind_dir / name}: {len(names)} members, expected {len(members)}")
            for f in rng.sample(members, min(SPOT_CHECKS_PER_ZIP, len(members))):
                if z.read(f.path.name) != f.path.read_bytes():
                    raise RuntimeError(f"{kind_dir / name}::{f.path.name}: bytes differ")


def write_index(
    build_id: int, index_dir: Path,
    entries: list[tuple[str, str, str, Frame]],  # (kind, archive, member, frame)
) -> Path:
    index_dir.mkdir(parents=True, exist_ok=True)
    path = index_dir / f"{build_id:03d}.parquet"
    table = pa.Table.from_pydict(
        {
            "build_id": [build_id] * len(entries),
            "ts_ms": [f.ts_ms for _, _, _, f in entries],
            "kind": [k for k, _, _, _ in entries],
            "archive": [a for _, a, _, _ in entries],
            "member": [m for _, _, m, _ in entries],
            "size_bytes": [f.size for _, _, _, f in entries],
        }
    )
    pq.write_table(table, path)
    return path


def deliver_build(
    build_id: int, frames_dir: Path, dataset: Path,
    chunk_size: int, force: bool,
) -> int:
    build_dir = frames_dir / str(build_id)
    if not build_dir.is_dir():
        print(f"ERROR: no frame buffer at {build_dir}", file=sys.stderr)
        return 1
    if not (dataset / ".git").exists():
        print(f"ERROR: dataset checkout missing at {dataset} — refusing "
              "(init the submodule; delivery never writes outside it)",
              file=sys.stderr)
        return 1

    tag = f"{build_id:03d}"
    by_kind = scan_frames(build_dir)
    total = sum(len(v) for v in by_kind.values())
    print(f"build {build_id}: {total} frames, kinds: "
          + ", ".join(f"{k}={len(v)}" for k, v in sorted(by_kind.items())))

    index_entries: list[tuple[str, str, str, Frame]] = []
    for kind, frames in sorted(by_kind.items()):
        kind_dir = dataset / "source" / "frames" / tag / kind
        chunks = write_zip_chunks(frames, kind_dir, chunk_size, force)
        verify_zips(kind_dir, chunks)
        rel = f"source/frames/{tag}/{kind}"
        for name, members in chunks:
            for f in members:
                index_entries.append((kind, f"{rel}/{name}", f.path.name, f))
        print(f"  {kind}: {len(chunks)} zip chunk(s) written + verified")

    idx = write_index(build_id, dataset / "data" / "frames_index", index_entries)
    print(f"  index: {idx.relative_to(dataset)} ({len(index_entries)} rows)")
    print(f"build {build_id}: delivered. Originals in {build_dir} untouched — "
          "delete only after HF push verification.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Zip + index a build's frames into the Telemetry dataset.")
    ap.add_argument("--build", type=int, required=True)
    ap.add_argument("--frames-dir", type=Path, default=REPO / "data" / "frames")
    ap.add_argument("--dataset", type=Path,
                    default=REPO / "datasets" / "Agentic-SLS-Telemetry")
    ap.add_argument("--chunk-size", type=int, default=CHUNK_SIZE)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    return deliver_build(args.build, args.frames_dir, args.dataset,
                         args.chunk_size, args.force)


if __name__ == "__main__":
    raise SystemExit(main())
