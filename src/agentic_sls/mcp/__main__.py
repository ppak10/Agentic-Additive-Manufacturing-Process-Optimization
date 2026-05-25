import logging
import sys

# MCP communicates over stdio. Redirect all logging to stderr so nothing
# from this process or its dependencies can corrupt the JSON-RPC stream on stdout.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from mcp.server.fastmcp import FastMCP

app = FastMCP(name="agentic-sls")


@app.tool()
def ping() -> str:
    """Health-check tool — returns a fixed string so clients can verify the server is reachable."""
    return "pong from agentic-sls"


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
