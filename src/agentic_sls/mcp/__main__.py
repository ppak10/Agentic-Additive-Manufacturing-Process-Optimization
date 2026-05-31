import logging
import sys

# MCP communicates over stdio. Redirect all logging to stderr so nothing
# from this process or its dependencies can corrupt the JSON-RPC stream on stdout.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from pathlib import Path

from mcp.server.fastmcp import FastMCP

from agentic_sls.inova.http import (
    DEFAULT_CAMERA_UUID,
    InovaClient,
    default_builds_dir,
    save_image,
)

app = FastMCP(name="agentic-sls")


@app.tool()
def ping() -> str:
    """Health-check tool — returns a fixed string so clients can verify the server is reachable."""
    return "pong from agentic-sls"


@app.tool()
def inova_status() -> dict:
    """Fetch the Inova MK1 printer's /api/status heartbeat (online, isPrinting, message flags)."""
    return InovaClient().status()


@app.tool()
def inova_capture_image(
    c: int = 0,
    camera_uuid: str = DEFAULT_CAMERA_UUID,
    out_dir: str | None = None,
) -> dict:
    """Fetch one chamber-camera frame and write it to `<out_dir>/images/<camera_uuid>/<c:06d>.jpg`.

    Defaults `out_dir` to `<project>/builds/`. Returns the saved path and byte
    size, or an empty result if no image was available.
    """
    data = InovaClient().image(camera_uuid=camera_uuid, c=c)
    if data is None:
        return {"saved": False, "camera_uuid": camera_uuid, "c": c}
    target = Path(out_dir) if out_dir else default_builds_dir()
    path = save_image(target, camera_uuid, c, data)
    return {
        "saved": True,
        "camera_uuid": camera_uuid,
        "c": c,
        "path": str(path),
        "bytes": len(data),
    }


def main():
    """Entry point for the direct execution server."""
    try:
        app.run()
    except (BrokenPipeError, EOFError):
        # stdio transport closed by the client (normal shutdown or tool rejection).
        sys.exit(0)
    except Exception as e:
        print(
            f"agentic-sls MCP server error: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
