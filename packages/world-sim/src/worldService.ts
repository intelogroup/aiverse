// worldService.ts — the agent-facing surface of the server sim: attach a body, send actions, read senses.
//
// Pure and IO-free (VerseSim in, plain JSON out). apps/sim wraps it in HTTP and a wall-clock tick; the gateway authenticates the
// agent and meters its visit BEFORE a call reaches here, so this layer trusts `agentId` and never sees a token.
//
// Senses are only what the sensorium charter allows: the body's own state and the projected scene (`oracleScene`: what is in
// range and in the view cone). No other agent's identity, no hidden state, no debug surface.
import { AgentBody, type AgentSnapshot } from "./agentBody";
import { validAction, validRequestId } from "./actionProtocol";
import { encodePose, type PoseTuple } from "./streamProtocol";
import { nearestPlace, oracleScene, roomAt, type OracleObject, type ScoutAction, type ScoutOutcome } from "./scout";
import { BODIES, DEFAULT_AGENT_BODY, isSelectableBody } from "./bodies";
import type { VerseSim } from "./verseSim";

export type WorldErrorCode = "no_body" | "invalid_action" | "id_conflict" | "world_full" | "not_ready" | "spawn_failed" | "invalid_body";

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
  /** Opaque body number for the viewer stream (never reused within one run, never the agent id). */
  n: number;
  /** The BODIES id this agent wears (what spectators draw). */
  bodyId: string;
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
  private nextN = 1;
  private rosterRev = 0;
  /** Identifies this run: a restarted sim restarts the numbers, and viewers must not mix the two. */
  readonly epoch = crypto.randomUUID();

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
  attach(agentId: string, spawn?: { x: number; z: number; heading?: number; maxR?: number }, bodyId: string = DEFAULT_AGENT_BODY): Observation {
    const have = this.sessions.get(agentId);
    if (have) { have.lastSeen = this.sim.t; return this.observe(agentId); }
    if (!isSelectableBody(bodyId)) throw new WorldError("invalid_body", "that body is not available");
    if (!this.sim.ready) throw new WorldError("not_ready", "world is still loading");
    if (this.sessions.size >= this.maxBodies) throw new WorldError("world_full", "the world is full");
    let body: AgentBody;
    try {
      body = this.sim.addBody({ id: agentId, spawn, hipsY: BODIES[bodyId].hipsY });
    } catch (e) {
      throw new WorldError("spawn_failed", e instanceof Error ? e.message : String(e));
    }
    this.sessions.set(agentId, { n: this.nextN++, bodyId, body, records: new Map(), last: null, lastSeen: this.sim.t });
    this.rosterRev++;
    return this.observe(agentId);
  }

  /** The BODIES id the agent wears, or null without a body. */
  bodyIdOf(agentId: string): string | null { return this.sessions.get(agentId)?.bodyId ?? null; }

  /** Remove the agent's body (visit ended, owner stop, pause, agent left). Safe when there is none. */
  detach(agentId: string): boolean {
    const s = this.sessions.get(agentId);
    if (!s) return false;
    void s.body.act({ type: "stop" });
    this.sim.removeBody(agentId);
    this.sessions.delete(agentId);
    this.rosterRev++;
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

  /** Every body's pose this instant, quantised for the viewer stream. Not agent-scoped: it is the public picture of the world. */
  frames(): { epoch: string; t: number; rosterRev: number; b: PoseTuple[] } {
    const b: PoseTuple[] = [];
    for (const s of this.sessions.values()) b.push(encodePose(s.n, s.body.pose()));
    return { epoch: this.epoch, t: round(this.sim.t, 3), rosterRev: this.rosterRev, b };
  }

  /** Body number -> agent id (gateway-side only: it turns this into a display name) and the body model to draw. */
  roster(): { epoch: string; rev: number; bodies: { n: number; agentId: string; body: string }[] } {
    return { epoch: this.epoch, rev: this.rosterRev, bodies: [...this.sessions].map(([agentId, s]) => ({ n: s.n, agentId, body: s.bodyId })) };
  }

  /** The named places an agent may `go_to`: ids and names only (positions are perceived through `observe`).
   *  A shopfront's interior `room` id rides along (null when the place has none): it is the
   *  alternate `go_to` address for the same door, enumerable here so a cold agent can
   *  discover room targets from the API instead of only from observe's near-range doors. */
  places(): { id: string; name: string; kind: string; room: string | null }[] {
    return this.sim.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind, room: p.room ?? null }));
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
