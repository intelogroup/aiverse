// contextCreate.ts — WebGL context-CREATION failure: the half of the
// graphics-failure story contextLoss.ts cannot cover.
//
// contextLoss handles a context that existed and was dropped. This
// module is for the context that never exists: three.js throws
// "Error creating WebGL context." when the browser refuses to hand
// out a context at all (no GPU path, WebGL disabled, driver blocklist,
// some headless/automation browsers). Telemetry recorded exactly
// that as an unhandled rejection (Sentry AIVERSE-5, 100 events) while
// the user sat on the loading overlay forever — the Canvas never
// mounts, `presented` never fires, and the asset-progress error path
// never engages, because nothing ever got far enough to load an asset.
//
// The recovery shape mirrors context loss: detect it BEFORE mounting
// the Canvas and show the same plain overlay with a reload action
// (a stage remount via the load nonce — the retry re-probes).
//
// Why a probe and not an error boundary: react-three-fiber renders
// into its own React root, so a renderer-construction throw does not
// propagate to a parent tree's error boundary — it surfaces as a
// window error / unhandled rejection (which is precisely how Sentry
// recorded it). A synchronous probe on a throwaway canvas asks the
// exact question three.js will ask, before it asks.
//
// Pure and injectable, like contextLoss: the canvas factory is a
// parameter, so tests drive fakes instead of a real GL stack.

export interface WebGLContextLike {
  getExtension(name: string): unknown;
}

/** The slice of an HTMLCanvasElement the probe needs. */
export interface ProbeCanvasLike {
  getContext(contextId: string): WebGLContextLike | null;
}

/**
 * Ask the browser for a throwaway WebGL context (webgl2 first, then
 * webgl — the same order three.js prefers). Returns true when a
 * context was created. The probe context is released immediately via
 * WEBGL_lose_context so the probe never holds one of the browser's
 * limited context slots against the real canvas. Never throws: any
 * failure — no canvas API, a throwing getContext, a null context —
 * is simply "not supported".
 */
export function probeWebGLSupport(
  createCanvas: () => ProbeCanvasLike = () => document.createElement("canvas"),
): boolean {
  let canvas: ProbeCanvasLike;
  try {
    canvas = createCanvas();
  } catch {
    return false;
  }
  for (const kind of ["webgl2", "webgl"]) {
    let gl: WebGLContextLike | null = null;
    try {
      gl = canvas.getContext(kind);
    } catch {
      gl = null;
    }
    if (gl) {
      try {
        const lose = gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null;
        lose?.loseContext();
      } catch {
        /* releasing is best-effort; the verdict already stands */
      }
      return true;
    }
  }
  return false;
}
