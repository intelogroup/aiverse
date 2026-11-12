// contextLoss.ts — WebGL context-loss recovery for the world canvas.
//
// Telemetry has *recorded* context losses since Phase 1 (Sentry holds
// a real user's, from /claim), but recording is all that happened:
// the user got a dead black canvas with no way back short of a full
// page reload. This module is the recovery half.
//
// Browser mechanics that shape it: a `webglcontextlost` event whose
// default is NOT prevented cancels the context for good; preventing
// the default keeps restoration possible, and the browser may then
// fire `webglcontextrestored` (GPU reset, driver recovery) — at which
// point three.js re-initialises and rendering resumes. When it does
// not restore, the overlay's reload action (a Canvas remount via the
// stage's load nonce — the same retry path as a failed load) is the
// guaranteed way back.
//
// Pure and DOM-shaped, not DOM-bound: anything with
// add/removeEventListener works, so tests drive a fake target.

export interface ContextLossHandlers {
  onLost: () => void;
  onRestored: () => void;
}

interface EventTargetLike {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

/**
 * Attach lost/restored listeners to a canvas. The lost handler
 * prevents the event's default FIRST (that is what makes restoration
 * possible at all), then notifies. Returns a detach function.
 */
export function attachContextLossHandlers(
  target: EventTargetLike,
  handlers: ContextLossHandlers,
): () => void {
  const onLost = (ev: Event) => {
    ev.preventDefault();
    handlers.onLost();
  };
  const onRestored = () => {
    handlers.onRestored();
  };
  target.addEventListener("webglcontextlost", onLost);
  target.addEventListener("webglcontextrestored", onRestored);
  return () => {
    target.removeEventListener("webglcontextlost", onLost);
    target.removeEventListener("webglcontextrestored", onRestored);
  };
}
