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


@app.get("/api/process-map")
def process_map() -> dict:
    """Specimen mechanical outcomes joined to their print-time process
    parameters — feeds the Research → Process Map page."""
    try:
        return db.fetch_process_map()
    except psycopg.errors.UndefinedTable:
        raise HTTPException(status_code=503, detail=registry.SYNC_HINT)


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


# Patch history reconstructed from the agent action log. The GUI page's local
# patch state can't survive a reload and never sees agent-driven sinters; the
# MCP server logs every powder_tuning_* call to agent_actions, so the current
# session's grid state is a replay of those rows: a successful stop resets,
# select_patch moves the cursor, print_patch records the setup actually used
# (its result envelope). Approval refusals log is_error=false but carry no
# `data` payload — the executed-check below drops them.
#
# The stop-row reset alone is not enough: conversation 75's session ended from
# the wizard after powder_tuning_stop 500'd, leaving a ghost grid in the replay
# window. So when the live session is inactive, return empty state instead of
# replaying. If the printer is unreachable the replay is served as-is (stale
# beats blank when we can't know either way).
_POWDER_ACTIONS_SQL = """
SELECT ts, tool, arguments, result, is_error
FROM agent_actions
WHERE tool LIKE 'powder_tuning_%%' AND ts > now() - %s * interval '1 hour'
ORDER BY ts
"""


@app.get("/api/powder-tuning/actions")
def powder_actions(hours: int = Query(48, ge=1, le=336)) -> dict:
    session_active: bool | None = None
    try:
        status = proxy.http_json_get(proxy.PLUGIN_BASE, "/powder-tuning/status")
        session_active = bool((status.get("data") or {}).get("isActive"))
    except HTTPException:
        pass
    if session_active is False:
        return {"selected": None, "patches": [], "window_hours": hours, "session_active": False}

    try:
        with db.pool.connection() as conn:
            rows = conn.execute(_POWDER_ACTIONS_SQL, (hours,)).fetchall()
    except psycopg.errors.UndefinedTable:
        rows = []

    def executed(result) -> bool:
        return isinstance(result, dict) and isinstance(result.get("data"), dict)

    selected: int | None = None
    patches: dict[str, dict] = {}  # keyed by grid index (or "unknown")
    for row in rows:
        if row["is_error"]:
            continue
        tool, args, result = row["tool"], row["arguments"] or {}, row["result"]
        if tool == "powder_tuning_stop" and executed(result):
            selected = None
            patches = {}
        elif tool == "powder_tuning_select_patch" and executed(result):
            if isinstance(args.get("grid_index"), int):
                selected = args["grid_index"]
        elif tool == "powder_tuning_print_patch" and executed(result):
            key = str(selected) if selected is not None else "unknown"
            patches[key] = {
                "grid_index": selected,
                "ts": row["ts"],
                "setup": result["data"],
            }
    return {
        "selected": selected,
        "patches": list(patches.values()),
        "window_hours": hours,
        "session_active": session_active,
    }


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
