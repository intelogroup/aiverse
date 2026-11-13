import { BASE } from "../../lib/api";
import {
  MOMENT_MIN_SCORE, cleanDetail, momentScore,
  type AgentEvent, type AgentEventType, type Cheer, type ClientEventType, type Passport,
} from "@aiverse/shared/events";

// Client side of the public event log: report what the Scout did, fan moments out to the share panel,
// and read the public spectator surfaces (events for cheers, passport, digest).

export type Moment = { type: AgentEventType; detail: string; name: string; at: number };

type Identity = { id: string; name: string; token: string };
let identity: Identity | null = null;
const idListeners = new Set<(i: Identity | null) => void>();
const momentListeners = new Set<(m: Moment) => void>();

export const getIdentity = () => identity;
export function onIdentity(fn: (i: Identity | null) => void) {
  idListeners.add(fn);
  fn(identity);
  return () => { idListeners.delete(fn); };
}
export function onMoment(fn: (m: Moment) => void) {
  momentListeners.add(fn);
  return () => { momentListeners.delete(fn); };
}

/** Local fan-out only (no network): the server already wrote it (claims) or the type is below the clip threshold. */
export function emitMoment(type: AgentEventType, detail: string, name = identity?.name ?? "Scout"): void {
  const d = cleanDetail(detail);
  if (momentScore(type, d) < MOMENT_MIN_SCORE) return;
  const m: Moment = { type, detail: d, name, at: Date.now() };
  for (const fn of momentListeners) fn(m);
}

/** Fire and forget: a lost event must never disturb the agent. */
export function reportEvent(type: ClientEventType, detail = ""): void {
  const d = cleanDetail(detail);
  emitMoment(type, d);
  if (!identity) return;
  void fetch(`${BASE}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${identity.token}` },
    body: JSON.stringify({ type, detail: d }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

/** Learn who the token belongs to (needed for public reads). Memory only. */
export async function setIdentityFromToken(token: string | null): Promise<void> {
  if (!token) { identity = null; idListeners.forEach(fn => fn(null)); return; }
  try {
    const r = await fetch(`${BASE}/agent/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const me = (await r.json()) as { id: string; name: string };
    identity = { id: me.id, name: me.name, token };
    idListeners.forEach(fn => fn(identity));
  } catch { /* offline: no identity, reports become local-only */ }
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}
export const fetchPassport = (id: string) => getJson<Passport>(`/public/agents/${id}/passport`);
export const fetchEvents = (id: string, since?: string) =>
  getJson<{ name: string; events: AgentEvent[] }>(`/public/agents/${id}/events?limit=20${since ? `&since=${encodeURIComponent(since)}` : ""}`);
export const fetchDigest = (id: string, since: string) =>
  getJson<{ name: string; total: number; moments: AgentEvent[] }>(`/public/agents/${id}/digest?since=${encodeURIComponent(since)}`);
export async function sendCheer(id: string, cheer: Cheer): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/public/agents/${id}/cheer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cheer }), signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch { return false; }
}
