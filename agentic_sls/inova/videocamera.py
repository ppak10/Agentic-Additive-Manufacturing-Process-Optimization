"""HTTP videocamera client for the Inova MK1.

Endpoint: GET /api/videocamera/image/<client_uuid>?c=<n>

The path segment is opaque to the printer — verified by hitting it with arbitrary
strings, all of which return a JPEG. We treat it as a per-process client tag:
a uuid4 generated at module load identifies this client's frames to the printer
and doubles as the on-disk subdirectory, so each session gets its own folder.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import requests

DEFAULT_TIMEOUT = 5.0
CLIENT_UUID = str(uuid.uuid4())


def fetch_image(
    base_url: str,
    client_uuid: str,
    c: int,
    timeout: float = DEFAULT_TIMEOUT,
) -> bytes | None:
    r = requests.get(
        f"{base_url}/api/videocamera/image/{client_uuid}",
        params={"c": c},
        timeout=timeout,
    )
    if r.status_code == 200 and r.content:
        return r.content
    return None


def save_image(out_dir: Path, client_uuid: str, c: int, data: bytes) -> Path:
    """Save a JPEG frame to `<out_dir>/images/<client_uuid>/<c:06d>.jpg`."""
    target_dir = out_dir / "images" / client_uuid
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{c:06d}.jpg"
    path.write_bytes(data)
    return path
