/**
 * Telemetry Phase 1 — console instrumentation entry.
 *
 * initTelemetry() runs once from main.tsx before the app renders;
 * attachWorldRenderer() is called from GlbWorld's Canvas onCreated —
 * that one call is the whole integration surface with the world code.
 *
 * Everything here is defensive by design: telemetry wraps the app, it
 * never sits in its critical path. Every hook is best-effort, every
 * failure is swallowed, and with no Sentry DSN configured the captures
 * are no-ops (the black-box still records locally for ?blackbox=1
 * export, which is how the lab pulls a session by hand).
 *
 * PRIVACY: world events only — positions, asset URLs, timings, error
 * text. Never chat content, form input, or credentials. See blackbox.ts.
 */

import type { Camera, WebGLRenderer } from "three";
import { blackbox, noteErrorKind, recordWorldEvent } from "./blackbox";
import {
  currentCameraPose,
  currentDistrict,
  deviceClass,
  registerCameraProvider,
  roundPose,
  setDistrictDefs,
  type DistrictDefLite,
} from "./context";
import { captureConsoleError, captureConsoleMessage, initConsoleSentry } from "./sentry";

declare const __AIVERSE_BUILD_SHA__: string | undefined;

export const BUILD_SHA: string =
  typeof __AIVERSE_BUILD_SHA__ !== "undefined" && __AIVERSE_BUILD_SHA__ ? __AIVERSE_BUILD_SHA__ : "dev";

export { blackbox, recordWorldEvent };

/** Classify a loader URL into the asset family the eval layer tracks. */
export function classifyAsset(url: string): string | null {
  const u = url.split("?")[0];
  if (u.endsWith("districts.json")) return "manifest";
  if (u.includes("world-city3-collision")) return "collision";
  if (u.includes("world-city3-library")) return "library";
  if (u.includes("world-city3")) return "city";
  if (u.includes("world-halo")) return "halo";
  const districtCollision = u.match(/world-([a-z0-9]+)-collision\.glb$/);
  if (districtCollision) return `collision:${districtCollision[1]}`;
  const district = u.match(/world-([a-z0-9]+)\.glb$/);
  if (district) return `district:${district[1]}`;
  if (u.includes("/residents/")) return "resident";
  if (u.includes("/interiors/")) return "interior";
  if (/\.(glb|gltf)$/.test(u)) return "asset";
  return null;
}

function shortUrl(url: string): string {
  try {
    return new URL(url, window.location.href).pathname;
  } catch {
    return url;
  }
}

/** Format one console call's arguments into a single bounded line for
 *  the black box. Errors keep name + message; objects are JSON with a
 *  circular guard; the result is length-capped so a runaway log call
 *  cannot bloat the ring buffer. */
export function formatLogArgs(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  });
  const joined = parts.join(" ");
  return joined.length > 1200 ? `${joined.slice(0, 1200)}\u2026` : joined;
}

const CONSOLE_CAPTURE_CAP = 100;
const CSP_CAPTURE_CAP = 5;

/** Console + policy capture, so a CDP/DevTools session can read the
 *  page's failures out of the black box (window.__aiverseTelemetry)
 *  instead of scraping the console panel: console.error/warn calls,
 *  CSP violations, and resource load failures are recorded next to the
 *  world events. The wrappers record, then call through — original
 *  console behavior is untouched — and capture is capped per kind so a
 *  log flood cannot evict the world recording. The first few CSP
 *  violations also go to Sentry: a policy that breaks the world (the
 *  2026-11-27 wasm block) should page us, not just sit in a buffer. */
function installConsoleCapture(): void {
  let errorCount = 0;
  let warnCount = 0;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    if (errorCount < CONSOLE_CAPTURE_CAP) {
      errorCount += 1;
      recordWorldEvent("console.error", { message: formatLogArgs(args), district: currentDistrict() });
    }
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (warnCount < CONSOLE_CAPTURE_CAP) {
      warnCount += 1;
      recordWorldEvent("console.warn", { message: formatLogArgs(args), district: currentDistrict() });
    }
    origWarn(...args);
  };

  let cspSent = 0;
  window.addEventListener("securitypolicyviolation", (ev) => {
    const data = {
      directive: ev.violatedDirective,
      blockedURI: ev.blockedURI,
      sample: (ev.sample ?? "").slice(0, 200),
    };
    recordWorldEvent("csp.violation", data);
    if (cspSent < CSP_CAPTURE_CAP) {
      cspSent += 1;
      captureConsoleMessage(`CSP violation: ${ev.violatedDirective} blocked ${ev.blockedURI}`, "csp.violation", data);
    }
  });

  // Resource load failures (img/script/link) surface as error events on
  // the element itself, never as window.onerror — the capture phase
  // listener is what sees them.
  window.addEventListener(
    "error",
    (ev) => {
      const target = ev.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (!target || ev.error || typeof target.tagName !== "string") return;
      const url = target.src ?? target.href ?? "";
      if (url) recordWorldEvent("resource.error", { tag: target.tagName.toLowerCase(), url: shortUrl(url) });
    },
    true,
  );
}

/** Per-asset load+parse timings via the shared LoadingManager. Handlers
 *  are chained, never replaced: drei's useProgress keeps working, and
 *  event-based items mean the district-streaming loader composes with
 *  this unchanged (each streamed file is just another item). */
function instrumentAssetLoading(): void {
  // Dynamic so three stays out of the entry chunk; the world chunk shares the same module.
  void import("three").then(({ DefaultLoadingManager }) => patchLoadingManager(DefaultLoadingManager)).catch(() => {});
}

function patchLoadingManager(loadingManager: unknown): void {
  const mgr = loadingManager as {
    itemStart: (url: string) => void;
    itemEnd: (url: string) => void;
    itemError: (url: string) => void;
  };
  const starts = new Map<string, number>();
  let assetErrorsSent = 0;
  const origStart = mgr.itemStart.bind(mgr);
  const origEnd = mgr.itemEnd.bind(mgr);
  const origError = mgr.itemError.bind(mgr);

  mgr.itemStart = (url: string) => {
    if (classifyAsset(url)) starts.set(url, performance.now());
    origStart(url);
  };
  mgr.itemEnd = (url: string) => {
    const started = starts.get(url);
    if (started !== undefined) {
      starts.delete(url);
      recordWorldEvent("asset.load", {
        url: shortUrl(url),
        kind: classifyAsset(url),
        ms: Math.round(performance.now() - started),
      });
    }
    origEnd(url);
  };
  mgr.itemError = (url: string) => {
    const kind = classifyAsset(url);
    if (kind) {
      recordWorldEvent("asset.error", { url: shortUrl(url), kind });
      if (assetErrorsSent < 5) {
        assetErrorsSent += 1;
        captureConsoleMessage(`asset load failed: ${shortUrl(url)}`, "asset.error", { url: shortUrl(url), kind });
      }
    }
    origError(url);
  };
}

/** Sampled FPS: a 4 s window every 20 s. In demand-frameloop (agent)
 *  mode a window may hold almost no frames — recorded as idle, not as
 *  a fake 0 fps. */
function startFpsSampler(): void {
  const WINDOW_MS = 4000;
  const PERIOD_MS = 20000;
  let frames: number[] = [];
  let last = 0;
  let sampling = false;
  const tick = (now: number) => {
    if (!sampling) return;
    if (last) frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  setInterval(() => {
    frames = [];
    last = 0;
    sampling = true;
    requestAnimationFrame(tick);
    setTimeout(() => {
      sampling = false;
      if (frames.length < 8) {
        recordWorldEvent("perf.fps", { mode: "idle", frames: frames.length, deviceClass: deviceClass() });
        return;
      }
      const sorted = [...frames].sort((a, b) => a - b);
      const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
      recordWorldEvent("perf.fps", {
        mode: "sample",
        fps: Math.round(1000 / avg),
        frameMsAvg: Math.round(avg * 10) / 10,
        frameMsP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
        deviceClass: deviceClass(),
      });
    }, WINDOW_MS);
  }, PERIOD_MS);
}

/** District tracking + teleport detection from the camera itself —
 *  no component state needed: 4 Hz pose sampling, a >75 m step between
 *  samples is a jump (framing click / teleport), and district changes
 *  fall out of the pose. */
function startCameraWatcher(): void {
  let lastPose: { x: number; y: number; z: number } | null = null;
  let lastDistrict = "unknown";
  setInterval(() => {
    const pose = currentPoseOrNull();
    if (!pose) return;
    if (lastPose) {
      const dx = pose.x - lastPose.x;
      const dy = pose.y - lastPose.y;
      const dz = pose.z - lastPose.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 75) {
        recordWorldEvent("camera.jump", { from: roundPose(lastPose), to: roundPose(pose), meters: Math.round(dist) });
      }
    }
    lastPose = pose;
    const district = currentDistrict();
    if (district !== lastDistrict) {
      recordWorldEvent("district.change", { from: lastDistrict, to: district, pose: roundPose(pose) });
      lastDistrict = district;
    }
  }, 250);
}

function currentPoseOrNull(): { x: number; y: number; z: number } | null {
  return currentCameraPose();
}

/** The one-call hook surface for the world renderer (GlbWorld onCreated):
 *  camera provider for context, WebGL context loss/restore, and shader
 *  compile failures via three's own debug callback. */
export function attachWorldRenderer(gl: WebGLRenderer, camera: Camera): void {
  registerCameraProvider(() => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }));
  const telemetryWindow = window as unknown as Record<string, unknown>;
  telemetryWindow.__aiverseTelemetryAttached = true;

  const canvas = gl.domElement;
  canvas.addEventListener("webglcontextlost", (ev) => {
    recordWorldEvent("webgl.contextlost", { district: currentDistrict() });
    captureConsoleMessage("WebGL context lost", "webgl.contextlost", { district: currentDistrict() });
    // Do not preventDefault: three/r3f owns restore policy; we observe.
    void ev;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    recordWorldEvent("webgl.contextrestored", { district: currentDistrict() });
  });

  const debug = (gl as unknown as { debug?: { onShaderError?: unknown } }).debug;
  if (debug && typeof debug === "object") {
    let shaderErrorsSent = 0;
    const previous = debug.onShaderError as ((...args: unknown[]) => void) | null | undefined;
    debug.onShaderError = (...args: unknown[]) => {
      const info = args
        .map((a) => (typeof a === "string" ? a.slice(0, 400) : ""))
        .filter(Boolean)
        .join(" ")
        .slice(0, 800);
      recordWorldEvent("webgl.shader_error", { info, district: currentDistrict() });
      if (shaderErrorsSent < 3) {
        shaderErrorsSent += 1;
        captureConsoleMessage("shader compile error", "webgl.shader_error", { info });
      }
      if (typeof previous === "function") previous(...args);
    };
  }

  recordWorldEvent("webgl.ready", { district: currentDistrict() });
}

function exportBlackbox(): void {
  const blob = new Blob([blackbox.toJSONL()], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aiverse-blackbox-${BUILD_SHA.slice(0, 8)}-${Date.now()}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  recordWorldEvent("blackbox.export", { events: blackbox.size });
}

let initialized = false;

export function initTelemetry(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  const w = window as unknown as Record<string, unknown>;
  w.__AIVERSE_BUILD_SHA__ = BUILD_SHA;
  w.__aiverseTelemetry = {
    buildSha: BUILD_SHA,
    blackbox,
    recordWorldEvent,
    exportBlackbox,
    captureError: (err: unknown) => {
      noteErrorKind("manual");
      captureConsoleError(err, "manual");
    },
    // CDP one-liners: __aiverseTelemetry.errors() / .dump()
    errors: (n = 50) =>
      blackbox
        .all()
        .filter(
          (e) =>
            e.type === "error" ||
            e.type.startsWith("console.") ||
            e.type === "csp.violation" ||
            e.type === "resource.error" ||
            e.type === "asset.error" ||
            e.type === "api.error" ||
            e.type === "react.error" ||
            e.type.startsWith("ws."),
        )
        .slice(-n),
    dump: () => blackbox.toJSONL(),
  };
  const meta = document.createElement("meta");
  meta.name = "aiverse-build-sha";
  meta.content = BUILD_SHA;
  document.head.appendChild(meta);

  const params = new URLSearchParams(window.location.search);
  recordWorldEvent("session.start", {
    buildSha: BUILD_SHA,
    deviceClass: deviceClass(),
    agentMode: params.get("agent") === "1",
    path: window.location.pathname,
  });

  // Keep the district mirror honest: same file DistrictWorld loads.
  fetch("/assets/districts.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((json: { districts?: DistrictDefLite[] } | null) => {
      if (json?.districts?.length) setDistrictDefs(json.districts);
    })
    .catch(() => {
      /* fallback defs stay in place */
    });

  window.addEventListener("error", (ev) => {
    const err = ev.error instanceof Error ? ev.error : new Error(ev.message || "unknown window error");
    recordWorldEvent("error", {
      message: err.message,
      name: err.name,
      stack: (err.stack ?? "").slice(0, 800),
      district: currentDistrict(),
      source: "window.error",
    });
    // No capture here: the SDK's global handlers capture the error and
    // the beforeSend hook (sentry.ts) enriches it. We only note the kind.
    noteErrorKind("window.error");
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason ?? "unhandled rejection"));
    recordWorldEvent("error", {
      message: reason.message,
      name: reason.name,
      stack: (reason.stack ?? "").slice(0, 800),
      district: currentDistrict(),
      source: "unhandledrejection",
    });
    noteErrorKind("unhandledrejection");
  });

  installConsoleCapture();
  instrumentAssetLoading();
  startFpsSampler();
  startCameraWatcher();
  void initConsoleSentry(BUILD_SHA);

  if (params.get("blackbox") === "1") {
    window.addEventListener("load", () => setTimeout(exportBlackbox, 1500));
  }
}
