# Dashboard image: dependencies pinned by npm ci from THIS service's own
# lockfile (dependency-isolation milestone, 2026-07-16). Source stays
# bind-mounted for vite HMR; node_modules comes from the image via an
# anonymous volume over the subpath (see compose.yml). Dep changes:
#   docker compose build web && docker compose up -d -V web
FROM node:22-bookworm
WORKDIR /mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization/services/web
# npm ci must run AS node: vite writes its .vite dep-optimizer cache into
# node_modules at runtime — root-owned modules broke module serving
# (empty-MIME errors in the browser, found live 2026-07-16).
RUN chown node:node .
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci
