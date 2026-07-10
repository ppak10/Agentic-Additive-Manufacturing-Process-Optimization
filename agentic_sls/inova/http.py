"""HTTP client for the Inova MK1 (SLS4All Compact) printer.

Wraps the public HTTP endpoints we've confirmed:

  GET /api/status                          -> small JSON heartbeat
  GET /api/videocamera/image/<uuid>?c=<n>  -> JPEG frame (see videocamera.py)

Reference: sibling repo SLS4All-Scripts/timelapse/run.py.
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

from agentic_sls.inova.videocamera import CLIENT_UUID, fetch_image, save_image

DEFAULT_BASE_URL = os.environ.get("AGENTIC_SLS_INOVA_URL", "http://192.168.1.146")
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


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def monitor(
    out_dir: Path | None = None,
    *,
    client_uuid: str = CLIENT_UUID,
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
                img = fetch_image(base_url, client_uuid, c, timeout=client.timeout)
                if img is not None:
                    path = save_image(out_dir, client_uuid, c, img)
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
