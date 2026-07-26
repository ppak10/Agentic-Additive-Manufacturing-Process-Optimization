import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Load VITE_* vars from the repo-root .env (single config home). Only
  // VITE_-prefixed vars reach the client.
  envDir: path.resolve(__dirname, "../.."),
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/stream": { target: "ws://localhost:3000", ws: true },
      "/api/temperature/bedmatrix/stream": { target: "ws://localhost:3000", ws: true },
      "/api/movement/position/stream": { target: "ws://localhost:3000", ws: true },
      "/api/camera/chamber/stream": { target: "ws://localhost:3000", ws: true },
      // Task runner (services/pipeline/agentic_sls/tasks, :3300) — MUST precede
      // the generic /api → recorder entry (first prefix match wins).
      "/api/tasks": { target: "http://localhost:3300" },
      // GUI API service (services/api, :3400) — stateless Postgres/Inova reads
      // migrating off the recorder. Each moved route gets its own prefix here,
      // ahead of the generic /api → recorder fallback (first prefix match wins).
      "/api/astm": { target: "http://localhost:3400" },
      "/api/registry": { target: "http://localhost:3400" },
      "/api/datasets/summary": { target: "http://localhost:3400" },
      "/api/calibration": { target: "http://localhost:3400" },
      // firmware/plugin proxies (phase 3). NB: /api/camera/*/stream WS entries
      // are listed above and win over /api/camera (first prefix match).
      "/api/info": { target: "http://localhost:3400" },
      "/api/camera": { target: "http://localhost:3400" },
      "/api/profiles": { target: "http://localhost:3400" },
      "/api/jobs": { target: "http://localhost:3400" },
      "/api/powder-tuning": { target: "http://localhost:3400" },
      "/api": { target: "http://localhost:3000" },
      "/healthz": { target: "http://localhost:3000" },
      // Agent session broker (harness/server.ts) — separate process from
      // the recorder on purpose; SSE flows through the plain HTTP proxy.
      // Regex key: a bare "/agent" prefix would also swallow the SPA's
      // /agents page route (prefix match), 404ing hard refreshes there.
      "^/agent/": { target: "http://localhost:3100" },
      // Defect-detection bridge (services/defect, :3200) — notify-only
      // client of the v05 model server on MAIL-10.
      "/defect": { target: "http://localhost:3200" },
    },
  },
});
