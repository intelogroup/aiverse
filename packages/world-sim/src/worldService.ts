// worldService.ts — the agent-facing surface of the server sim: attach a body, send actions, read senses.
//
// Pure and IO-free (VerseSim in, plain JSON out). apps/sim wraps it in HTTP and a wall-clock tick; the gateway authenticates the
// agent and meters its visit BEFORE a call reaches here, so this layer trusts `agentId` and never sees a token.
//
// Senses are only what the sensorium charter allows: the body's own state and the projected scene (`oracleScene`: what is in
// range and in the view cone). No other agent's identity, no hidden state, no debug surface.
import { AgentBody, type AgentSnapshot } from "./agentBody";
import { validAction, validRequestId } from "./actionProtocol";
import { nearestPlace, oracleScene, roomAt, type OracleObject, type ScoutAction, type ScoutOutcome } from "./scout";
import type { VerseSim } from "./verseSim";

export type WorldErrorCode = "no_body" | "invalid_action" | "id_conflict" | "world_full" | "not_ready" | "spawn_failed";

export class WorldError extends Error {
  constructor(readonly code: WorldErrorCode, message: string) { super(message); }
}

export interface ActRecord {
  id: string;
  action: ScoutAction;
  state: "running" | "settled";
  outcome?: ScoutOutcome;
  /** Simulation seconds the action was accepted / settled at. */
  startedAt: number;
  settledAt?: number;
}

export interface Observation {
  /** Simulation time, s. */
  t: number;
  body: AgentSnapshot;
  nearestPlace: { id: string; name: string; kind: string; dist: number } | null;
  insideRoom: string | null;
  scene: OracleObject[];
  /** The latest action record (running or settled), so a poller needs one call. */
  lastAct: ActRecord | null;
}

export interface WorldServiceOpts {
  sim: VerseSim;
  /** Bodies allowed at once (platform cost cap). */
  maxBodies?: number;
  /** A body whose agent has not touched it for this many SIMULATION seconds is told to stop (the agent went away). */
  leaseS?: number;
  /** Settled action records kept per body for polling. */
  keepRecords?: number;
}

interface Session {
  body: AgentBody;
  records: Map<string, ActRecord>;
  last: ActRecord | null;
  lastSeen: number;
}

export class WorldService {
  readonly sim: VerseSim;
  private readonly sessions = new Map<string, Session>();
  private readonly maxBodies: number;
  private readonly leaseS: number;
  private readonly keepRecords: number;

  constructor(opts: WorldServiceOpts) {
    this.sim = opts.sim;
    this.maxBodies = opts.maxBodies ?? 200;
    this.leaseS = opts.leaseS ?? 30;
    this.keepRecords = opts.keepRecords ?? 64;
  }

  get bodyCount(): number { return this.sessions.size; }
  has(agentId: string): boolean { return this.sessions.has(agentId); }
  agentIds(): string[] { return [...this.sessions.keys()]; }

  /** Give the agent a body (idempotent: an agent that already has one keeps it). */
  attach(agentId: string, spawn?: { x: number; z: number; heading?: number; maxR?: number }): Observation {
    const have = this.sessions.get(agentId);
    if (have) { have.lastSeen = this.sim.t; return this.observe(agentId); }
    if (!this.sim.ready) throw new WorldError("not_ready", "world is still loading");
    if (this.sessions.size >= this.maxBodies) throw new WorldError("world_full", "the world is full");
    let body: AgentBody;
    try {
      body = this.sim.addBody({ id: agentId, spawn });
    } catch (e) {
      throw new WorldError("spawn_failed", e instanceof Error ? e.message : String(e));
    }
    this.sessions.set(agentId, { body, records: new Map(), last: null, lastSeen: this.sim.t });
    return this.observe(agentId);
  }

  /** Remove the agent's body (visit ended, owner stop, pause, agent left). Safe when there is none. */
  detach(agentId: string): boolean {
    const s = this.sessions.get(agentId);
    if (!s) return false;
    void s.body.act({ type: "stop" });
    this.sim.removeBody(agentId);
    this.sessions.delete(agentId);
    return true;
  }

  private session(agentId: string): Session {
    const s = this.sessions.get(agentId);
    if (!s) throw new WorldError("no_body", "no body: attach one first");
    s.lastSeen = this.sim.t;
    return s;
  }

  /**
   * Submit one action. Returns at once with the record (`running`); it turns `settled` when the body finishes, is blocked, times out
   * or is cancelled. Same id + same action: the first record. Same id + another action: `id_conflict`.
   */
  act(agentId: string, id: string, action: unknown): ActRecord {
    const s = this.session(agentId);
    if (!validRequestId(id) || !validAction(action)) throw new WorldError("invalid_action", "invalid action or id");
    const existing = s.records.get(id);
    if (existing && JSON.stringify(existing.action) !== JSON.stringify(action)) throw new WorldError("id_conflict", "request ID reused with different action");
    if (existing) return existing;
    const rec: ActRecord = { id, action: action as ScoutAction, state: "running", startedAt: this.sim.t };
    // Submitted synchronously (the executor's submit is), so the very next tick already walks; the record is the idempotency ledger.
    void s.body.act(rec.action).then((outcome) => {
      rec.outcome = outcome;
      rec.state = "settled";
      rec.settledAt = this.sim.t;
    });
    s.records.set(id, rec);
    s.last = rec;
    while (s.records.size > this.keepRecords) {
      const oldest = s.records.keys().next().value as string;
      if (s.records.get(oldest)?.state === "running") break;
      s.records.delete(oldest);
    }
    return rec;
  }

  actRecord(agentId: string, id: string): ActRecord | undefined {
    return this.session(agentId).records.get(id);
  }

  observe(agentId: string): Observation {
    const s = this.session(agentId);
    const st = s.body.state;
    const np = nearestPlace(this.sim.places, st.x, st.z);
    const room = roomAt(this.sim.rooms, st.x, st.z);
    const interactables = this.sim.interact.list().map((i) => ({ id: i.id, label: i.label, kind: i.kind, pos: [i.pos[0], i.pos[2]] as [number, number], on: this.sim.interact.isOn(i.id) }));
    return {
      t: round(this.sim.t, 2),
      body: s.body.snapshot(),
      nearestPlace: np ? { id: np.place.id, name: np.place.name, kind: np.place.kind, dist: round(np.dist, 2) } : null,
      insideRoom: room?.name ?? null,
      scene: oracleScene(this.sim.places, this.sim.rooms, { x: st.x, z: st.z, heading: st.body }, {}, interactables),
      lastAct: s.last,
    };
  }

  /** The named places an agent may `go_to`: ids and names only (positions are perceived through `observe`). */
  places(): { id: string; name: string; kind: string }[] {
    return this.sim.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
  }

  /** Advance the world by `dt` simulation seconds and stop bodies whose agent went quiet. */
  tick(dt: number): void {
    this.sim.tick(dt);
    for (const [id, s] of this.sessions) {
      if (this.sim.t - s.lastSeen > this.leaseS && s.body.busy) {
        void s.body.act({ type: "stop" });
        s.lastSeen = this.sim.t; // one stop per lease period, not one per tick
      }
      void id;
    }
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
