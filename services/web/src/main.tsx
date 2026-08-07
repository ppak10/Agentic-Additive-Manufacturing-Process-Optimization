import { createRoot } from "react-dom/client";
import "./globals.css";
import { App } from "./App";

// No StrictMode (2026-07-30): this dashboard is SERVED from vite dev mode
// permanently (that's the deployment — see CLAUDE.md), and StrictMode's
// dev-only double-render was a standing 2× tax on every interaction of the
// "production" UI. Re-add it temporarily when hunting effect-cleanup bugs.
createRoot(document.getElementById("root")!).render(<App />);
