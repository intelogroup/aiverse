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
