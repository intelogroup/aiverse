/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Telemetry Phase 1: the build SHA the console reports (window global +
// meta tag + Sentry release) — parity with the gateway's /version.
// Vercel injects VERCEL_GIT_COMMIT_SHA at build time; VITE_BUILD_SHA is
// the explicit override for local/other builds.
const buildSha = process.env.VITE_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "dev";

export default defineConfig({
  plugins: [react()],
  define: {
    __AIVERSE_BUILD_SHA__: JSON.stringify(buildSha),
  },
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
