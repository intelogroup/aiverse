/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { defineConfig } from "vite";

// Telemetry Phase 1: the build SHA the console reports (window global +
// meta tag + Sentry release) — parity with the gateway's /version.
// Vercel injects VERCEL_GIT_COMMIT_SHA at build time; VITE_BUILD_SHA is
// the explicit override for local/other builds.
const buildSha = process.env.VITE_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "dev";

// World tiles are the default only when this build actually has them (build_tiles.sh is non-fatal in `bun run build`): a build
// without tiles, and the test run, fall back to the one-file world. ?tiles=0 / ?tiles=1 still override at runtime.
const tilesDefault = !process.env.VITEST && existsSync(new URL("./public/assets/tiles/districts.json", import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __AIVERSE_BUILD_SHA__: JSON.stringify(buildSha),
    __TILES_DEFAULT__: JSON.stringify(tilesDefault),
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
