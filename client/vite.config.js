import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => {
  return {
    resolve: {
      alias: {
        "lodash/isEqualWith": "/src/test/lodash-isEqualWith.js"
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
        inline: ["@testing-library/jest-dom", "lodash"],
        optimizer: {
          web: {
            include: ["@testing-library/jest-dom", "lodash"]
          }
        }
      }
    }
  };
});
