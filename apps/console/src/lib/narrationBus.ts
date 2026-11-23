// A one-line private narration from the owner's OWN agent (gateway: owner-console socket only, never public). A tiny module-level bus
// so the socket hook in App.tsx (which owns the owner session) can reach the world view without threading props through WorldView.
export interface AgentNarration { agentId: string; agentName: string; kind: "visible" | "thinking"; text: string; at: number }

type Listener = (n: AgentNarration) => void;
const listeners = new Set<Listener>();

export function publishNarration(n: AgentNarration): void {
  for (const fn of listeners) { try { fn(n); } catch { /* a listener must never break the socket */ } }
}

export function subscribeNarration(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
