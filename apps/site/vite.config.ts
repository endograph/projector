import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The session routes (/s/:id) are client-side; serve index.html for them.
  appType: "spa",
  // Reachable over the tailnet, and pinned off 5173 (another app on this
  // machine already serves there).
  server: {
    host: true,
    port: 5199,
    // The long-lived dev server (herdr `site-dev` pane) repeatedly missed
    // fsevents for files edited by agent tooling and kept serving stale
    // transforms until restarted. Polling is boringly reliable.
    watch: { usePolling: true, interval: 300 },
  },
  build: {
    // The marketing page must stay light: the React app is only ever reached
    // through dynamic import in boot.ts, so it splits into its own chunks and
    // nothing framework-sized loads before the visitor shows intent.
    modulePreload: { polyfill: false },
  },
});
