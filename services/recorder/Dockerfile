# Recorder image: deps pinned from this service's own lockfile (dependency
# isolation, 2026-07-16). Source bind-mounted; node_modules from the image
# via anonymous volume. Dep changes: build + `up -d -V recorder` — AT A
# SAFE MOMENT ONLY (never while a print is recording).
FROM node:22-bookworm
WORKDIR /mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization/services/recorder
COPY package.json package-lock.json ./
RUN npm ci
USER node
