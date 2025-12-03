import { defineConfig, loadEnv } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => {
  return {
    resolve: {
      alias: {
        "lodash/isEqualWith": path.resolve(__dirname, "src/test/lodash-isEqualWith.js"),
        "lodash/isEqualWith.js": path.resolve(__dirname, "src/test/lodash-isEqualWith.js")
      }
    },
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
    },
    test: {
      environment: "jsdom",
      globals: true,
      server: {
        host: "127.0.0.1"
      },
      setupFiles: "./src/test/setupTests.js",
      deps: {
        inline: [],
        optimizer: {
          web: {
            include: ["@testing-library/jest-dom", "lodash"]
          }
        }
      }
    }
  };
});
