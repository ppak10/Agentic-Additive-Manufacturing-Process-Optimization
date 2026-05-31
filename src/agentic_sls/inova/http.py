"""HTTP client for the Inova MK1 (SLS4All Compact) printer.

Wraps the two public HTTP endpoints we've confirmed:

  GET /api/status                          -> small JSON heartbeat
  GET /api/videocamera/image/<uuid>?c=<n>  -> JPEG frame from the build chamber

The corresponding reference is sibling repo SLS4All-Scripts/timelapse/run.py,
which polls the same endpoints; this module ports that pattern into the plugin
with NDJSON status logging and a per-print image directory layout.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import requests

DEFAULT_BASE_URL = os.environ.get("AGENTIC_SLS_INOVA_URL", "http://192.168.1.146")
DEFAULT_CAMERA_UUID = os.environ.get("AGENTIC_SLS_INOVA_CAMERA", "basehexv3")
DEFAULT_TIMEOUT = 5.0


def default_builds_dir() -> Path:
    """Resolve `<project>/builds/` — project root comes from plugin.json's env passthrough."""
    root = os.environ.get("AGENTIC_SLS_PROJECT_DIR") or os.getcwd()
    return Path(root) / "builds"


@dataclass(frozen=True)
class InovaClient:
    base_url: str = DEFAULT_BASE_URL
    timeout: float = DEFAULT_TIMEOUT

    def status(self) -> dict:
        r = requests.get(f"{self.base_url}/api/status", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def image(self, camera_uuid: str = DEFAULT_CAMERA_UUID, c: int = 0) -> bytes | None:
        r = requests.get(
            f"{self.base_url}/api/videocamera/image/{camera_uuid}",
            params={"c": c},
            timeout=self.timeout,
        )
        if r.status_code == 200 and r.content:
            return r.content
        return None


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def save_image(out_dir: Path, camera_uuid: str, c: int, data: bytes) -> Path:
    """Save a JPEG frame to `<out_dir>/images/<camera_uuid>/<c:06d>.jpg`."""
    target_dir = out_dir / "images" / camera_uuid
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{c:06d}.jpg"
    path.write_bytes(data)
    return path


def monitor(
    out_dir: Path | None = None,
    *,
    camera_uuid: str = DEFAULT_CAMERA_UUID,
    interval: float = 1.0,
    base_url: str = DEFAULT_BASE_URL,
    start_c: int = 0,
) -> Iterator[dict]:
    """Poll /api/status + camera image at `interval` seconds, write NDJSON + JPEGs.

    Yields one event dict per poll so callers can react or count. Runs forever
    until the caller stops iterating. Defaults to `<project>/builds/`.
    """
    out_dir = Path(out_dir) if out_dir is not None else default_builds_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    ndjson_path = out_dir / "status.ndjson"
    client = InovaClient(base_url=base_url)
    c = start_c

    with ndjson_path.open("a", encoding="utf-8") as fp:
        while True:
            ts = _utcnow_iso()
            event: dict = {"ts": ts, "c": c, "kind": "poll"}
            try:
                event["status"] = client.status()
            except requests.RequestException as e:
                event["status_error"] = f"{type(e).__name__}: {e}"

            try:
                img = client.image(camera_uuid=camera_uuid, c=c)
                if img is not None:
                    path = save_image(out_dir, camera_uuid, c, img)
                    event["image_path"] = str(path.relative_to(out_dir))
                    event["image_bytes"] = len(img)
                else:
                    event["image_path"] = None
            except requests.RequestException as e:
                event["image_error"] = f"{type(e).__name__}: {e}"

            fp.write(json.dumps(event) + "\n")
            fp.flush()
            yield event
            c += 1
            time.sleep(interval)
