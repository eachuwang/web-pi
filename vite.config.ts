import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server (5173) talks to the Hono backend (3000) directly via CORS.
// In production, `vite build` emits to ../dist and Hono serves it on the same port.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    watch: {
      usePolling: true,
      interval: 100,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
