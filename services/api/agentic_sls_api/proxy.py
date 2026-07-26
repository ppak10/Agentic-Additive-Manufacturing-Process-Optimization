"""Reverse-proxy to the Inova firmware plugin (:5001) and firmware (:80).

Migrated from the recorder's api/routes.ts (2026-07-20, recorder→api phase 3):
the GUI's job/profile/powder-tuning CRUD, /info, and camera-image reads are
stateless proxies to the printer — they don't touch recording state, so they
belong here off the recorder's restart-gated process.

Mirrors the recorder's three helpers (httpProxy / cameraProxy / pluginProxy)
including the per-host circuit breaker: on a connection failure we trip the host
for a short window and short-circuit subsequent calls, so a printer outage (the
browser polls camera images at ~24 fps × 3 kinds) doesn't pile up sockets.

NONE of these routes log operator_action (only the recorder's mid-print override
POSTs do that, and those stay in the recorder) — so moving them is side-effect
free.
"""

from __future__ import annotations

import os
import time
from uuid import uuid4

import httpx
from fastapi import HTTPException, Response
from fastapi.responses import JSONResponse

# Host-networked container → same reachability as the recorder. Defaults match
# the recorder config.ts; compose passes the .env values through.
PLUGIN_BASE = os.environ.get("INOVA_API_BASE_URL", "http://192.168.1.146:5001")
FIRMWARE_BASE = os.environ.get("INOVA_FIRMWARE_BASE_URL", "http://192.168.1.146")

# Shared client; httpx.Client is safe to share across FastAPI's threadpool
# workers. Short connect timeout so a downed host fails fast into the breaker.
_client = httpx.Client(timeout=httpx.Timeout(15.0, connect=3.0))

# ── per-host circuit breaker ─────────────────────────────────────────────────
_TRIP_SECONDS = 2.0
_open_until: dict[str, float] = {}


def _is_open(host: str) -> bool:
    return time.monotonic() < _open_until.get(host, 0.0)


def _trip(host: str) -> None:
    _open_until[host] = time.monotonic() + _TRIP_SECONDS


# ── helpers ──────────────────────────────────────────────────────────────────
def http_json_get(base: str, path: str):
    """GET JSON from an upstream (used by /api/info)."""
    if _is_open(base):
        raise HTTPException(status_code=502, detail="upstream unreachable (breaker open)")
    try:
        r = _client.get(f"{base}{path}")
    except httpx.HTTPError:
        _trip(base)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    if not r.is_success:
        raise HTTPException(status_code=502, detail=f"upstream {r.status_code}")
    return r.json()


def camera_image(path: str, mime: str) -> Response:
    """GET a binary image from the firmware, cache-busted with a UUID suffix
    (same as the recorder's cameraProxy). Breaker keyed on the firmware host."""
    if _is_open(FIRMWARE_BASE):
        raise HTTPException(status_code=502, detail="upstream unreachable (breaker open)")
    try:
        r = _client.get(f"{FIRMWARE_BASE}{path}{uuid4()}")
    except httpx.HTTPError:
        _trip(FIRMWARE_BASE)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    if not r.is_success:
        raise HTTPException(status_code=502, detail=f"upstream {r.status_code}")
    return Response(content=r.content, media_type=mime)


def plugin(method: str, path: str, body=None):
    """Generic method+body proxy to the plugin, status pass-through: 204 → empty,
    400/404 relayed, other non-2xx → 502. Mirrors the recorder's pluginProxy."""
    if _is_open(PLUGIN_BASE):
        raise HTTPException(status_code=502, detail="upstream unreachable (breaker open)")
    kwargs = {}
    if body is not None and method not in ("GET", "DELETE"):
        kwargs["json"] = body
    try:
        r = _client.request(method, f"{PLUGIN_BASE}{path}", **kwargs)
    except httpx.HTTPError:
        _trip(PLUGIN_BASE)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    if r.status_code == 204:
        return Response(status_code=204)
    try:
        payload = r.json()
    except (ValueError, httpx.HTTPError):
        payload = {"status": r.status_code}
    if r.is_success:
        code = r.status_code
    elif r.status_code in (400, 404):
        code = r.status_code
    else:
        code = 502
    return JSONResponse(status_code=code, content=payload)


def plugin_binary(path: str, *, pass_through=(404, 422)) -> Response:
    """Byte-passthrough GET from the plugin (job meshes) — hands the raw bytes to
    the browser for Three.js. `pass_through` status codes are relayed as-is."""
    if _is_open(PLUGIN_BASE):
        raise HTTPException(status_code=502, detail="upstream unreachable (breaker open)")
    try:
        r = _client.get(f"{PLUGIN_BASE}{path}")
    except httpx.HTTPError:
        _trip(PLUGIN_BASE)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    if r.status_code in pass_through:
        try:
            detail = r.json()
        except (ValueError, httpx.HTTPError):
            detail = {"error": "upstream"}
        return JSONResponse(status_code=r.status_code, content=detail)
    if not r.is_success:
        raise HTTPException(status_code=502, detail=f"upstream {r.status_code}")
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "application/octet-stream"),
    )
