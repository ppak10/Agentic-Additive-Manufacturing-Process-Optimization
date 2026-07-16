# Defect-bridge image: deps pinned from this service's own lockfile.
# Source bind-mounted; node_modules from the image via anonymous volume.
# Dep changes: build + `up -d -V defect` (safe anytime — the bridge is a
# pure consumer; restarting it never affects recording).
FROM node:22-bookworm
WORKDIR /mnt/storage2/GitHub/Agentic-Additive-Manufacturing-Process-Optimization/services/defect
COPY package.json package-lock.json ./
RUN npm ci
USER node
