/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { worldPreloadScript, type WorldManifestLike } from "./worldPreload.js";

// Telemetry Phase 1: the build SHA the console reports (window global +
// meta tag + Sentry release) — parity with the gateway's /version.
// Vercel injects VERCEL_GIT_COMMIT_SHA at build time; VITE_BUILD_SHA is
// the explicit override for local/other builds.
const buildSha = process.env.VITE_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "dev";

// World tiles are the default only when this build actually has them (build_tiles.sh is non-fatal in `bun run build`): a build
// without tiles, and the test run, fall back to the one-file world. ?tiles=0 / ?tiles=1 still override at runtime.
const tilesDefault = !process.env.VITEST && existsSync(new URL("./public/assets/tiles/districts.json", import.meta.url));

// Tile mode: ask for the core tile, its textures and the KTX2 transcoder from index.html (first byte), not from the JS (worldPreload.ts).
// Emitted as a file, not inline: the CSP (vercel.json) is script-src 'self', and an inline script's hash changes with every tile build.
const WORLD_PRELOAD_FILE = "world-preload.js";
function worldPreload(): Plugin {
  let script = "";
  return {
    name: "aiverse-world-preload",
    apply: "build",
    buildStart() {
      script = "";
      if (!tilesDefault) return;
      try { script = worldPreloadScript(JSON.parse(readFileSync(new URL("./public/assets/tiles/districts.json", import.meta.url), "utf8")) as WorldManifestLike); } catch { return; }
      if (script) this.emitFile({ type: "asset", fileName: WORLD_PRELOAD_FILE, source: script });
    },
    transformIndexHtml() {
      return script ? [{ tag: "script", attrs: { src: `/${WORLD_PRELOAD_FILE}` }, injectTo: "head-prepend" }] : undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), worldPreload()],
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
