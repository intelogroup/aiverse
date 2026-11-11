// A tiny registry so "this agent is gone" (visit ended, paused, killed, key rotated, deleted) reaches the world sim without
// ws/gateway.ts importing the world code. forceDisconnectAgent is already called on every one of those paths; it notifies here.
type Hook = (agentId: string, reason: string) => void | Promise<void>;
const hooks = new Set<Hook>();

export function onAgentGone(hook: Hook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/** Fire-and-forget: a failing hook must never break the pause / kill / visit-end that triggered it. */
export function notifyAgentGone(agentId: string, reason: string): void {
  for (const h of hooks) {
    try { void Promise.resolve(h(agentId, reason)).catch(() => {}); } catch { /* best effort */ }
  }
}

// The mirror image: a visit's deadline moved (owner extension). The world
// route listens so a live body's sim-side expiry — stamped from the visit
// deadline at attach time — is re-stamped to the new deadline; without it
// the sim would retire the body at the OLD deadline while the extended
// visit still reads active (the state divergence the 2026-11-11 loadtest
// found: bodies gone, visits active).
type ExtendedHook = (agentId: string, endsAtMs: number) => void | Promise<void>;
const extendedHooks = new Set<ExtendedHook>();

export function onVisitExtended(hook: ExtendedHook): () => void {
  extendedHooks.add(hook);
  return () => extendedHooks.delete(hook);
}

/** Fire-and-forget, same discipline as notifyAgentGone. */
export function notifyVisitExtended(agentId: string, endsAtMs: number): void {
  for (const h of extendedHooks) {
    try { void Promise.resolve(h(agentId, endsAtMs)).catch(() => {}); } catch { /* best effort */ }
  }
}
