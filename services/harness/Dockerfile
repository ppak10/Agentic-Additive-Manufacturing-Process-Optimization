# Broker image: pinned harness CLIs = experimental control for the thesis.
# These versions are the recorded "harness versions during data collection";
# bump them deliberately, in a commit, never implicitly via brew.
FROM node:22-bookworm
RUN npm install -g \
      @anthropic-ai/claude-code@2.1.187 \
      @openai/codex@0.144.1 \
      opencode-ai@1.15.12
# agy (Antigravity CLI) has no npm distribution — bind-mounted by compose.
# Pre-create home subdirs as node — docker would otherwise auto-create
# nested bind-mount parents (~/.local/...) as root, breaking CLIs that
# mkdir state dirs at runtime (opencode/Bun hit this).
RUN mkdir -p /home/node/.local/state /home/node/.local/share \
      /home/node/.config /home/node/.cache \
  && chown -R node:node /home/node
# Dependency isolation (2026-07-16): broker + MCP-server deps baked from
# their own lockfiles; anonymous volumes in compose surface them over the
# repo bind. Also retires launch-local.cjs's runtime npm-install bootstrap.
WORKDIR /mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization/services/harness
COPY services/harness/package.json services/harness/package-lock.json ./
RUN npm ci
WORKDIR /mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization/services/plugins/mcp
COPY services/plugins/mcp/package.json services/plugins/mcp/package-lock.json ./
RUN npm ci
WORKDIR /mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization
ENV HOME=/home/node
USER node
