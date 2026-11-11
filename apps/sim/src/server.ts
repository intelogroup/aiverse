// server.ts — apps/sim's internal HTTP surface. Private: only the gateway calls it, with SIM_INTERNAL_SECRET.
//
// The gateway owns identity (token, pause, claim, visit budget, presence) and passes only the agent id; this service never sees an
// agent token. It still defends itself: constant-time secret check, 4 KB body cap, per-agent rate limits, and a hard expiry per body
// (the visit's deadline) so a missed "visit ended" call from the gateway cannot leave a body walking.
import { createHash, timingSafeEqual } from "node:crypto";
import { WorldError, WorldService, type WorldErrorCode } from "@aiverse/world-sim/worldService";

export const MAX_BODY_BYTES = 4096;
/** Wire version: the gateway sends it; a mismatch is refused so a half-deployed pair fails loudly instead of misreading actions. */
export const SIM_API_VERSION = 1;

const STATUS: Record<WorldErrorCode, number> = {
  no_body: 404, invalid_action: 400, id_conflict: 409, world_full: 503, not_ready: 503, spawn_failed: 503,
};

/** Token bucket: `rate` tokens/s, burst `burst`. Time is injected for tests. */
class Bucket {
  private tokens: number;
  private at: number;
  constructor(private readonly rate: number, private readonly burst: number, now: number) { this.tokens = burst; this.at = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface SimServerOpts {
  service: WorldService;
  secret: string;
  now?: () => number;
  /** Per-agent limits (requests per second): actions and reads. */
  actPerS?: number;
  readPerS?: number;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createSimServer(opts: SimServerOpts) {
  const { service, secret } = opts;
  const now = opts.now ?? Date.now;
  const want = digest(secret);
  const actRate = opts.actPerS ?? 2;
  const readRate = opts.readPerS ?? 5;
  const acts = new Map<string, Bucket>();
  const reads = new Map<string, Bucket>();
  const expiry = new Map<string, number>();
  // One gateway pulls at <= ~10/s; allow a few gateways plus bursts.
  const streamBucket = new Bucket(40, 80, now());

  const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers });
  const bucket = (m: Map<string, Bucket>, id: string, rate: number) => {
    let b = m.get(id);
    if (!b) m.set(id, (b = new Bucket(rate, Math.max(2, rate * 2), now())));
    return b;
  };

  /** Remove bodies whose visit deadline passed (called from the tick loop, and before any request). */
  function expire(): string[] {
    const t = now(), gone: string[] = [];
    for (const [id, at] of expiry) if (at <= t) { service.detach(id); expiry.delete(id); acts.delete(id); reads.delete(id); gone.push(id); }
    return gone;
  }

  async function readJson(req: Request): Promise<unknown> {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too large");
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "bad json"); }
  }

  async function handle(req: Request): Promise<Response> {
    const got = digest((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (!timingSafeEqual(got, want)) return json({ error: "unauthorized" }, 401);
    if (req.headers.get("x-sim-api") !== String(SIM_API_VERSION)) return json({ error: "version_mismatch", want: SIM_API_VERSION }, 426);
    expire();
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return json({ ready: service.sim.ready, bodies: service.bodyCount, t: service.sim.t });
      if (req.method === "GET" && url.pathname === "/places") return json({ places: service.places() });
      if (req.method === "GET" && url.pathname === "/bodies") return json({ agentIds: service.agentIds() });
      // The viewer stream's source. Gateway-only like everything here; its own bucket so spectators never eat an agent's read budget.
      if (req.method === "GET" && url.pathname === "/frames") {
        if (!streamBucket.take(now())) return json({ error: "rate_limited" }, 429, { "retry-after": "1" });
        return json(service.frames());
      }
      if (req.method === "GET" && url.pathname === "/roster") return json(service.roster());

      if (req.method === "POST" && url.pathname === "/bodies") {
        const b = (await readJson(req)) as { agentId?: unknown; expiresAtMs?: unknown; spawn?: { x?: unknown; z?: unknown } };
        if (typeof b.agentId !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(b.agentId)) throw new HttpError(400, "agentId required");
        const exp = Number(b.expiresAtMs);
        if (!Number.isFinite(exp) || exp <= now()) throw new HttpError(400, "expiresAtMs must be in the future");
        const sp = b.spawn && Number.isFinite(Number(b.spawn.x)) && Number.isFinite(Number(b.spawn.z)) ? { x: Number(b.spawn.x), z: Number(b.spawn.z) } : undefined;
        const had = service.has(b.agentId);
        const obs = service.attach(b.agentId, sp);
        expiry.set(b.agentId, exp);
        return json({ observation: obs }, had ? 200 : 201);
      }

      const [root, id, sub, actId] = parts;
      if (root === "bodies" && id) {
        if (req.method === "DELETE" && !sub) { expiry.delete(id); return json({ removed: service.detach(id) }); }
        if (req.method === "GET" && !sub) {
          if (!bucket(reads, id, readRate).take(now())) return json({ error: "rate_limited" }, 429, { "retry-after": "1" });
          return json({ body: service.body(id) });
        }
        if (req.method === "GET" && sub === "observe") {
          if (!bucket(reads, id, readRate).take(now())) return json({ error: "rate_limited" }, 429, { "retry-after": "1" });
          return json({ observation: service.observe(id) });
        }
        if (req.method === "GET" && sub === "act" && actId) {
          if (!bucket(reads, id, readRate).take(now())) return json({ error: "rate_limited" }, 429, { "retry-after": "1" });
          const rec = service.actRecord(id, actId);
          return rec ? json({ act: rec }) : json({ error: "unknown_act" }, 404);
        }
        if (req.method === "POST" && sub === "act" && !actId) {
          if (!bucket(acts, id, actRate).take(now())) return json({ error: "rate_limited" }, 429, { "retry-after": "1" });
          const b = (await readJson(req)) as { id?: unknown; action?: unknown };
          // 202: a new act; 200: the same id and action again (idempotent replay, the gateway does not count it).
          const replay = typeof b.id === "string" && service.has(id) && service.actRecord(id, b.id) !== undefined;
          return json({ act: service.act(id, b.id as string, b.action) }, replay ? 200 : 202);
        }
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof WorldError) return json({ error: e.code, message: e.message }, STATUS[e.code]);
      console.error("sim request failed", e);
      return json({ error: "internal" }, 500);
    }
  }

  return { fetch: handle, expire, expiryCount: () => expiry.size };
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
