/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    // Removing ActivityFeed.test.tsx (dead component, 2026-09-24) left this
    // workspace with zero test files, and vitest hard-fails CI on that by
    // default. A workspace can legitimately have no tests for a while —
    // don't let an empty suite block the pipeline.
    passWithNoTests: true,
  },
  server: {
    port: 5183,
    proxy: {
      "/api": {
        target: "http://localhost:3010",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        ws: true,
      },
    },
  },
});
