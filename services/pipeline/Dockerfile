# agentic-sls-tasks — async runner for the sls-* pipeline jobs (FastAPI + a
# single sequential worker). The repo is bind-mounted at runtime (see
# compose.yml); the workspace venv is built on boot via `uv sync` into
# UV_PROJECT_ENVIRONMENT (a repo-local, gitignored .tasks-venv, kept separate
# from the host's .venv). git/curl cover job side-effects + the healthcheck.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

# Copy mode: the venv lives on a bind mount, cache elsewhere — hardlinks across
# filesystems fail, so copy instead (avoids noisy warnings / errors).
ENV UV_LINK_MODE=copy
