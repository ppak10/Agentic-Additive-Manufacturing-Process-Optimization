"""FastAPI app for the GUI API service.

Phase 1 (2026-07-19): ASTM specimen reads, to bootstrap the service. Routes are
mounted under /api so a path is identical whether hit directly (:3400) or via
the vite `/api/*` proxy. More stateless read/proxy routes migrate here from the
recorder in later phases (see CLAUDE.md).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

import uvicorn
import psycopg
from fastapi import Body, FastAPI, HTTPException, Query

from . import curves, db, proxy, registry


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.pool.open()
    try:
        yield
    finally:
        db.pool.close()


app = FastAPI(title="Agentic SLS API", version="0.0.1", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    db.ping()
    return {"ok": True}


@app.get("/api/astm")
def astm() -> list[dict]:
    return db.fetch_astm()


@app.get("/api/astm/curves")
def astm_curves(standard: str = Query("D638", pattern="^D(638|790)$")) -> dict:
    return curves.load_curves(standard)


# ── registry / knowledge (migrated from recorder knowledge.ts) ───────────────
@app.get("/api/registry")
def registry_list() -> list[dict]:
    try:
        return registry.fetch_registry()
    except psycopg.errors.UndefinedTable:
        raise HTTPException(status_code=503, detail=registry.SYNC_HINT)


@app.get("/api/registry/{build_id}/card")
def registry_card(build_id: int) -> dict:
    try:
        card = registry.fetch_build_card(build_id)
    except psycopg.errors.UndefinedTable:
        raise HTTPException(status_code=503, detail=registry.SYNC_HINT)
    if card is None:
        raise HTTPException(status_code=404, detail=f"no build {build_id}")
    return card


@app.get("/api/datasets/summary")
def datasets_summary() -> dict:
    return registry.fetch_datasets_summary()


# ── operator calibrations (migrated from recorder routes.ts) ─────────────────
@app.get("/api/calibration/{kind}")
def calibration_get(kind: str) -> dict:
    row = registry.get_calibration(kind)
    if row is None:
        raise HTTPException(status_code=404, detail="no calibration recorded")
    return row


@app.post("/api/calibration/{kind}")
def calibration_post(kind: str, body: dict = Body(...)) -> dict:
    payload = body.get("payload")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="body.payload (object) required")
    return registry.insert_calibration(kind, payload, body.get("source"), body.get("note"))


# ── firmware / plugin proxies (migrated from recorder routes.ts, phase 3) ────
@app.get("/api/info")
def info():
    return proxy.http_json_get(proxy.PLUGIN_BASE, "/info")


@app.get("/api/camera/chamber.jpg")
def camera_chamber():
    return proxy.camera_image("/api/videocamera/image/", "image/jpeg")


@app.get("/api/camera/thermal.gif")
def camera_thermal():
    return proxy.camera_image("/api/bedmatrix/image/", "image/gif")


@app.get("/api/camera/galvo.png")
def camera_galvo():
    return proxy.camera_image("/api/plottedimage/", "image/png")


# Print profiles — thin proxy to the plugin's /profiles/* (bare JSON, status
# pass-through). Profiles carry a ~250 KB stats blob; the GUI wants it raw, so
# (unlike the MCP server) we do NOT project it away here.
@app.get("/api/profiles")
def profiles_list():
    return proxy.plugin("GET", "/profiles")


@app.get("/api/profiles/{profile_id}")
def profile_get(profile_id: str, merged: bool = False):
    qs = "?merged=true" if merged else ""
    return proxy.plugin("GET", f"/profiles/{profile_id}{qs}")


@app.post("/api/profiles")
def profile_create(body: dict = Body(...)):
    return proxy.plugin("POST", "/profiles", body)


@app.put("/api/profiles/{profile_id}")
def profile_update(profile_id: str, body: dict = Body(...)):
    return proxy.plugin("PUT", f"/profiles/{profile_id}", body)


@app.delete("/api/profiles/{profile_id}")
def profile_delete(profile_id: str):
    return proxy.plugin("DELETE", f"/profiles/{profile_id}")


# Powder-tuning session commands — thin proxies to the plugin's /powder-tuning/*.
@app.get("/api/powder-tuning/status")
def powder_status():
    return proxy.plugin("GET", "/powder-tuning/status")


@app.post("/api/powder-tuning/layer")
def powder_layer(body: dict = Body(...)):
    return proxy.plugin("POST", "/powder-tuning/layer", body)


@app.post("/api/powder-tuning/bed-level")
def powder_bed_level(body: dict = Body(...)):
    return proxy.plugin("POST", "/powder-tuning/bed-level", body)


@app.post("/api/powder-tuning/surface")
def powder_surface(body: dict = Body(...)):
    return proxy.plugin("POST", "/powder-tuning/surface", body)


@app.post("/api/powder-tuning/params")
def powder_params(body: dict = Body(...)):
    return proxy.plugin("POST", "/powder-tuning/params", body)


@app.get("/api/powder-tuning/print/setup")
def powder_print_setup():
    return proxy.plugin("GET", "/powder-tuning/print/setup")


@app.post("/api/powder-tuning/print")
def powder_print(body: dict = Body(...)):
    return proxy.plugin("POST", "/powder-tuning/print", body)


@app.post("/api/powder-tuning/stop")
def powder_stop():
    return proxy.plugin("POST", "/powder-tuning/stop")


# Stored-job CRUD — thin proxy to the plugin's /jobs/* (bare JSON). More-specific
# subpaths (/instances, /clone, /meshes) are distinct templates from /jobs/{id}.
@app.get("/api/jobs")
def jobs_list():
    return proxy.plugin("GET", "/jobs")


@app.get("/api/jobs/{job_id}")
def job_get(job_id: str):
    return proxy.plugin("GET", f"/jobs/{job_id}")


@app.patch("/api/jobs/{job_id}")
def job_patch(job_id: str, body: dict = Body(...)):
    return proxy.plugin("PATCH", f"/jobs/{job_id}", body)


@app.delete("/api/jobs/{job_id}")
def job_delete(job_id: str):
    return proxy.plugin("DELETE", f"/jobs/{job_id}")


@app.post("/api/jobs/{job_id}/clone")
def job_clone(job_id: str, body: dict = Body(...)):
    return proxy.plugin("POST", f"/jobs/{job_id}/clone", body)


@app.get("/api/jobs/{job_id}/instances")
def job_instances(job_id: str):
    return proxy.plugin("GET", f"/jobs/{job_id}/instances")


@app.get("/api/jobs/{job_id}/meshes/{mesh_hash}")
def job_mesh(job_id: str, mesh_hash: str):
    return proxy.plugin_binary(f"/jobs/{job_id}/meshes/{mesh_hash}")


def main() -> None:
    port = int(os.environ.get("API_PORT", "3400"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
