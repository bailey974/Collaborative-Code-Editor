import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";


// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;


export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});