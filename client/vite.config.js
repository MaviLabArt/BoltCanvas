import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode === "analyze" &&
      visualizer({
        filename: "bundle-stats.html",
        template: "treemap",
        open: true
      })
  ].filter(Boolean),
  server: {
    host: "127.0.0.1",
    port: 5173,
    hmr: { clientPort: 8080 }
  }
}));
