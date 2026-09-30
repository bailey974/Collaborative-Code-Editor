import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API and collaboration server run under `wrangler dev`
// (server/, port 8787). Proxy them so the app is same-origin, like production.
const WORKER_URL = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": WORKER_URL,
      "/parties": { target: WORKER_URL, ws: true },
    },
  },
  worker: { format: "es" },
});
