import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      "/api/plotter/commands/stream": { target: "ws://localhost:3000", ws: true },
      "/api/camera/chamber/stream": { target: "ws://localhost:3000", ws: true },
      "/api": { target: "http://localhost:3000" },
      "/healthz": { target: "http://localhost:3000" },
    },
  },
});
