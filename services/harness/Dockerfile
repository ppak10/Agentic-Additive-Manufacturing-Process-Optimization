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
ENV HOME=/home/node
USER node
