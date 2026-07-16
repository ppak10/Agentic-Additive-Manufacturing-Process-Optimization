"""Deliver imported spool NDJSON into the Telemetry dataset's source/spool/.

The recorder's importer renames spool files to *.ndjson.imported after
committing their rows to Postgres. Those files are the rawest form of the
tick data (exact upstream frames) — this tool gzips them into
`source/spool/<NNN>/<stream>.ndjson.gz`, completing the source-based
layout for ticks and turning the "imported files accumulate on the NVMe"
TODO into an archival step.

Idempotent: an existing, integrity-checked target is skipped. Never
deletes the NVMe originals — that stays manual, after HF push
verification (same gate as frames). Files still named *.ndjson (not yet
imported into Postgres) are always skipped.

Usage:
  uv run sls-deliver-spool                # all builds with imported files
  uv run sls-deliver-spool --build 44
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent.parent.parent
DEFAULT_SPOOL = Path.home() / ".agentic-sls" / "spool"


def gz_ok(path: Path) -> bool:
    try:
        with gzip.open(path, "rb") as f:
            while f.read(1 << 20):
                pass
        return True
    except (OSError, EOFError, gzip.BadGzipFile):
        return False


def deliver_build(build_dir: Path, dataset: Path, force: bool) -> list[str]:
    build_id = int(build_dir.name)
    out_dir = dataset / "source" / "spool" / f"{build_id:03d}"
    done: list[str] = []
    for src in sorted(build_dir.glob("*.ndjson.imported")):
        stream = src.name.replace(".ndjson.imported", "")
        target = out_dir / f"{stream}.ndjson.gz"
        if target.exists() and not force and gz_ok(target):
            done.append(f"{stream} (kept)")
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".gz.tmp")
        with src.open("rb") as fin, gzip.open(tmp, "wb", compresslevel=6) as fout:
            shutil.copyfileobj(fin, fout, length=1 << 20)
        if not gz_ok(tmp):
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"{target}: integrity check failed after write")
        tmp.replace(target)
        done.append(stream)
    return done


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Gzip imported spool NDJSON into the Telemetry dataset.")
    ap.add_argument("--build", type=int, default=None)
    ap.add_argument("--spool-dir", type=Path, default=DEFAULT_SPOOL)
    ap.add_argument("--dataset", type=Path,
                    default=REPO / "datasets" / "Agentic-SLS-Telemetry")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if not (args.dataset / ".git").exists():
        print(f"ERROR: dataset checkout missing at {args.dataset}", file=sys.stderr)
        return 1
    if not args.spool_dir.is_dir():
        print(f"nothing to do: no spool at {args.spool_dir}")
        return 0

    dirs = [d for d in sorted(args.spool_dir.iterdir(), key=lambda p: p.name)
            if d.is_dir() and d.name.isdigit()
            and (args.build is None or int(d.name) == args.build)]
    total = 0
    for d in dirs:
        streams = deliver_build(d, args.dataset, args.force)
        if streams:
            total += len([s for s in streams if "(kept)" not in s])
            print(f"build {int(d.name):03d}: {', '.join(streams)}")
        pending = list(d.glob("*.ndjson"))
        if pending:
            print(f"build {int(d.name):03d}: {len(pending)} un-imported file(s) skipped")
    print(f"delivered {total} stream file(s). NVMe originals untouched — "
          "delete after HF push verification.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
