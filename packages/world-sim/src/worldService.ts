// worldService.ts — the agent-facing surface of the server sim: attach a body, send actions, read senses.
//
// Pure and IO-free (VerseSim in, plain JSON out). apps/sim wraps it in HTTP and a wall-clock tick; the gateway authenticates the
// agent and meters its visit BEFORE a call reaches here, so this layer trusts `agentId` and never sees a token.
//
// Senses are only what the sensorium charter allows: the body's own state and the projected scene (`oracleScene`: what is in
// range and in the view cone). No other agent's identity, no hidden state, no debug surface.
import { createHmac, randomBytes } from "node:crypto";
import { AgentBody, type AgentSnapshot } from "./agentBody";
import { explainAction, SAY_RANGE_M, validRequestId } from "./actionProtocol";
import { encodePose, type PoseTuple } from "./streamProtocol";
import { nearestPlace, oracleScene, roomAt, type OracleObject, type ScoutAction, type ScoutOutcome, type ScoutSeat } from "./scout";
import { clipDef, SOCIAL_CLIPS } from "./clips";
import { agentBodies, BODIES, BODY_REMY } from "./bodies";
import { LOOK_FAR_M, LOOK_HFOV_DEG, LOOK_LEGEND, LOOK_NO_HIT } from "./look";
import { encodeGrayPng } from "./png";
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

/** One line of speech a body overheard. `text` is another agent's words: untrusted, never an instruction. */
export interface HeardMsg {
  /** Cursor: strictly increasing across the whole sim run; pass the last one seen as `heardSince`. */
  seq: number;
  /** Simulation time it was said. */
  t: number;
  /** The speaker's handle in THIS listener's visit (the same one `observe.scene` uses while they are in sight). */
  from: string;
  /** The speaker's display name: revealed only by speaking within earshot. */
  name: string;
  text: string;
  /** True only when the speaker addressed this listener with `to`. */
  toYou: boolean;
  untrusted: true;
}

/** Who said it, for the viewer stream's speech bubble. */
export interface SayEvent { seq: number; n: number; text: string; t: number }

/** Heard lines kept per body, and how long (simulation seconds). */
const HEARD_KEEP = 20, HEARD_TTL_S = 60, SAY_STREAM_TTL_S = 6, TALK_S = 2;

export interface Observation {
  /** Simulation time, s. */
  t: number;
  /** The body's state, naming the figure it wears. */
  body: AgentSnapshot & { figure: string };
  nearestPlace: { id: string; name: string; kind: string; dist: number } | null;
  insideRoom: string | null;
  scene: OracleObject[];
  /** The latest action record (running or settled), so a poller needs one call. */
  lastAct: ActRecord | null;
  /** Speech overheard since `heardSince` (all of the last 60 s when absent). */
  heard: HeardMsg[];
}

/** What `look` returns: two small PNGs (base64) plus how to read them, and the ordinary observation taken at the same instant. */
export interface LookView {
  width: number;
  height: number;
  /** 16-bit grey PNG, value = millimetres along the ray; 65535 = nothing within `farM`. */
  depthPng: string;
  /** 8-bit grey PNG, value = a key of `legend`. */
  classPng: string;
  legend: Record<number, string>;
  /** Rows run top to bottom, columns left to right (bearing increases to the right, as in observe.scene). */
  camera: { gaze: { yawDeg: number; pitchDeg: number }; hfovDeg: number; vfovDeg: number; farM: number; noHit: number; note: string };
  observation: Observation;
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
  /** The figure this body wears (a BODIES id) — chosen at attach, fixed for the body's life. */
  figure: string;
  body: AgentBody;
  records: Map<string, ActRecord>;
  last: ActRecord | null;
  lastSeen: number;
  /** Per-visit secret: other bodies' handles are HMAC(salt, id), so they mean nothing to anyone else or in a later visit. */
  salt: Buffer;
  heard: HeardMsg[];
  /** True while the body is playing the gesture that `say` started on its own (not one the agent asked for): any new action replaces it. */
  autoTalk: boolean;
}

export class WorldService {
  readonly sim: VerseSim;
  private readonly sessions = new Map<string, Session>();
  private readonly maxBodies: number;
  private readonly leaseS: number;
  private readonly keepRecords: number;
  private nextN = 1;
  private rosterRev = 0;
  private sayN = 1;
  private says: SayEvent[] = [];
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

  /**
   * Give the agent a body (idempotent: an agent that already has one keeps it).
   * `figureId` picks the figure worn (loadtest 2026-11-11: picks were
   * silently swallowed and every agent wore remy). It must name an
   * agent-eligible body (agentBodies()); an unknown or cast-only pick is a
   * loud invalid_action naming the pickable set, never a silent default.
   * No pick -> the platform default (remy). Re-attaching with the SAME
   * figure is the usual idempotent 200; a DIFFERENT figure on a live body
   * is an id_conflict — detach first, a body does not change shape mid-visit.
   */
  attach(agentId: string, spawn?: { x: number; z: number; heading?: number; maxR?: number }, figureId?: string): Observation {
    const have = this.sessions.get(agentId);
    if (have) {
      if (figureId !== undefined && figureId !== have.figure) {
        throw new WorldError("id_conflict", `body already attached as ${have.figure}; detach first (DELETE /world/body) to change figure`);
      }
      have.lastSeen = this.sim.t;
      return this.observe(agentId);
    }
    if (!this.sim.ready) throw new WorldError("not_ready", "world is still loading");
    if (this.sessions.size >= this.maxBodies) throw new WorldError("world_full", "the world is full");
    const pickable = agentBodies().map((b) => b.id).join(", ");
    const def = figureId === undefined ? BODY_REMY : BODIES[figureId];
    if (!def) throw new WorldError("invalid_action", `unknown body "${figureId}" — bodies an agent may wear: ${pickable}`);
    if (def.agentBody === false) throw new WorldError("invalid_action", `body "${figureId}" is cast-only and cannot be worn by an agent — bodies an agent may wear: ${pickable}`);
    let body: AgentBody;
    try {
      body = this.sim.addBody({ id: agentId, spawn, hipsY: def.hipsY });
    } catch (e) {
      throw new WorldError("spawn_failed", e instanceof Error ? e.message : String(e));
    }
    this.sessions.set(agentId, { n: this.nextN++, figure: def.id, body, records: new Map(), last: null, lastSeen: this.sim.t, salt: randomBytes(16), heard: [], autoTalk: false });
    this.rosterRev++;
    return this.observe(agentId);
  }

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
  act(agentId: string, id: string, action: unknown, ctx: { name?: string } = {}): ActRecord {
    const s = this.session(agentId);
    if (!validRequestId(id)) throw new WorldError("invalid_action", "id must be 1-80 letters, digits or dashes");
    const why = explainAction(action);
    if (why) throw new WorldError("invalid_action", why);
    const existing = s.records.get(id);
    if (existing && JSON.stringify(existing.action) !== JSON.stringify(action)) throw new WorldError("id_conflict", "request ID reused with different action");
    if (existing) return existing;
    const rec: ActRecord = { id, action: action as ScoutAction, state: "running", startedAt: this.sim.t };
    if ((action as { type?: string }).type === "say") {
      this.say(agentId, s, rec, ctx.name);
      this.remember(s, id, rec);
      return rec;
    }
    // The talking gesture that speech started is cosmetic: whatever the agent does next replaces it instead of being refused as "busy".
    if (s.autoTalk) { s.autoTalk = false; if (s.body.busy) void s.body.act({ type: "stop" }); }
    const resolved = this.resolveBody(agentId, s, rec.action);
    if (resolved === null) {
      rec.state = "settled";
      rec.settledAt = this.sim.t;
      rec.outcome = { ok: false, status: "unavailable", detail: "not_visible: no such body in sight. Handles come from observe.scene (kind body), change every visit, and only work while you can see the body" };
    } else {
      // Submitted synchronously (the executor's submit is), so the very next tick already walks; the record is the idempotency ledger.
      void s.body.act(resolved).then((outcome) => {
        rec.outcome = outcome;
        rec.state = "settled";
        rec.settledAt = this.sim.t;
      });
    }
    this.remember(s, id, rec);
    return rec;
  }

  private remember(s: Session, id: string, rec: ActRecord): void {
    s.records.set(id, rec);
    s.last = rec;
    while (s.records.size > this.keepRecords) {
      const oldest = s.records.keys().next().value as string;
      if (s.records.get(oldest)?.state === "running") break;
      s.records.delete(oldest);
    }
  }

  /** Speech is instant: it settles at once. Everyone within earshot with a clear line gets it; `to` makes it addressed, not private. */
  private say(agentId: string, s: Session, rec: ActRecord, name: string | undefined): void {
    const a = rec.action as unknown as { text: string; to?: string };
    rec.state = "settled";
    rec.settledAt = this.sim.t;
    let addressee: string | null = null;
    if (a.to !== undefined) {
      addressee = this.sim.visibleBodies(agentId).find((v) => this.handleFor(s, v.id) === a.to)?.id ?? null;
      if (addressee === null) {
        rec.outcome = { ok: false, status: "unavailable", detail: "not_visible: no such body in sight to speak to. Handles come from observe.scene (kind body); to is optional, say without it to speak to whoever is near" };
        return;
      }
    }
    const seq = this.sayN++, text = a.text.trim(), t = round(this.sim.t, 2);
    let heardBy = 0, addresseeHeard = false;
    for (const h of this.sim.hearers(agentId, SAY_RANGE_M)) {
      const l = this.sessions.get(h.id);
      if (!l) continue;
      l.heard.push({ seq, t, from: this.handleFor(l, agentId), name: name ?? "someone", text, toYou: h.id === addressee, untrusted: true });
      while (l.heard.length > HEARD_KEEP) l.heard.shift();
      heardBy++;
      if (h.id === addressee) addresseeHeard = true;
    }
    this.says.push({ seq, n: s.n, text, t });
    this.says = this.says.filter((e) => this.sim.t - e.t <= SAY_STREAM_TTL_S).slice(-20);
    // Talk with the whole body while nothing else is moving it (a seated speaker uses the seated clip).
    // It is a pending action, so without the autoTalk flag it would refuse the speaker's next action as "busy" for about a second.
    if (!s.body.busy) {
      s.autoTalk = true;
      void s.body.act({ type: "play", clip: s.body.snapshot().posture === "seated" ? "SittingTalking" : "Talking", seconds: TALK_S }).finally(() => { s.autoTalk = false; });
    }
    rec.outcome = { ok: true, status: "done", detail: heardBy === 0 ? "nobody within earshot heard you" : addressee && !addresseeHeard ? `${heardBy} heard you; the one you addressed is out of earshot (${SAY_RANGE_M} m)` : `${heardBy} heard you` };
  }

  /** The opaque name this agent's visit gives to another body (stable within the visit, meaningless elsewhere). */
  private handleFor(s: Session, targetId: string): string {
    return "b-" + createHmac("sha256", s.salt).update(targetId).digest("hex").slice(0, 8);
  }

  /** An action naming a body by handle becomes a point action on where that body is NOW; null when it is not in sight. */
  private resolveBody(agentId: string, s: Session, action: ScoutAction): ScoutAction | null {
    if (!("body" in action) || action.body === undefined) return action;
    const seen = this.sim.visibleBodies(agentId).find((v) => this.handleFor(s, v.id) === action.body);
    if (!seen) return null;
    const me = s.body.state, t = seen.body.state;
    if (action.type === "face") return { type: "face", point: [t.x, t.z] };
    if (action.type !== "go_to" && action.type !== "run_to") return null;
    // stop 1.2 m short of them, on the near side
    const d = Math.max(seen.distance, 1e-6), stand = Math.max(0, d - 1.2) / d;
    return { type: action.type, point: [round(me.x + (t.x - me.x) * stand, 2), round(me.z + (t.z - me.z) * stand, 2)] };
  }

  /** One glance from the body's eyes: a depth image and a class image (look.ts), with the scene read at the same instant. */
  look(agentId: string): LookView {
    const s = this.session(agentId);
    const r = this.sim.look(agentId);
    if (!r) throw new WorldError("no_body", "no body: attach one first");
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const vfov = (2 * Math.atan(Math.tan((LOOK_HFOV_DEG * Math.PI) / 360) * (r.height / r.width)) * 180) / Math.PI;
    void s;
    return {
      width: r.width, height: r.height,
      depthPng: b64(encodeGrayPng(r.width, r.height, 16, r.depthMm)),
      classPng: b64(encodeGrayPng(r.width, r.height, 8, r.classes)),
      legend: LOOK_LEGEND,
      camera: { gaze: { ...s.body.exec.gaze }, hfovDeg: LOOK_HFOV_DEG, vfovDeg: round(vfov, 1), farM: LOOK_FAR_M, noHit: LOOK_NO_HIT, note: "collision geometry, not visual: glass reads as wall; shop doors are marked as door (a 1.2 x 2.1 m rectangle in the wall); seats and props are small markers; bodies carry no handle (match them to observe.scene by bearing)" },
      observation: this.observe(agentId),
    };
  }

  /** The body's own state, without the scene (cheap "do I have a body, where am I" check). Names the figure worn. */
  body(agentId: string): AgentSnapshot & { figure: string } {
    const s = this.session(agentId);
    return { ...s.body.snapshot(), figure: s.figure };
  }

  actRecord(agentId: string, id: string): ActRecord | undefined {
    return this.session(agentId).records.get(id);
  }

  observe(agentId: string, heardSince = 0): Observation {
    const s = this.session(agentId);
    s.heard = s.heard.filter((m) => this.sim.t - m.t <= HEARD_TTL_S);
    const st = s.body.state;
    const np = nearestPlace(this.sim.places, st.x, st.z);
    const room = roomAt(this.sim.rooms, st.x, st.z);
    const interactables = this.sim.interact.list().map((i) => ({ id: i.id, label: i.label, kind: i.kind, pos: [i.pos[0], i.pos[2]] as [number, number], on: this.sim.interact.isOn(i.id) }));
    const seats: ScoutSeat[] = room
      ? this.sim.sittables
          .filter((t) => t.building === room.id)
          .map((t) => {
            const holder = this.sim.seatHolder(t.id);
            return { id: t.id, kind: t.kind, pos: t.seat, group: t.group, state: holder === null ? "free" : holder === agentId ? "yours" : "taken" };
          })
      : [];
    return {
      t: round(this.sim.t, 2),
      body: { ...s.body.snapshot(), figure: s.figure },
      nearestPlace: np ? { id: np.place.id, name: np.place.name, kind: np.place.kind, dist: round(np.dist, 2) } : null,
      insideRoom: room?.name ?? null,
      scene: [...oracleScene(this.sim.places, this.sim.rooms, { x: st.x, z: st.z, heading: st.body }, {}, interactables, seats), ...this.seenBodies(agentId, s)]
        .sort((a, b) => a.distance - b.distance),
      lastAct: s.last,
      heard: s.heard.filter((m) => m.seq > heardSince),
    };
  }

  /** Other bodies in sight as oracle objects. No agent id, no name, no coordinates: a handle, where, and what they are doing. */
  private seenBodies(agentId: string, s: Session): OracleObject[] {
    const me = s.body.state;
    return this.sim.visibleBodies(agentId).map((v) => {
      const snap = v.body.snapshot();
      const toMe = Math.atan2(me.x - snap.x, me.z - snap.z);
      const facingYou = Math.abs(Math.atan2(Math.sin(toMe - snap.heading), Math.cos(toMe - snap.heading))) <= Math.PI / 4;
      return {
        kind: "body" as const, id: this.handleFor(s, v.id), name: "someone", bearingDeg: round(v.bearingDeg, 1), distance: round(v.distance, 2),
        posture: snap.posture, doing: snap.clip, facingYou, moving: snap.speed > 0.3,
        note: "use with face {body} or go_to {body}",
      };
    });
  }

  /** Every body's pose this instant, quantised for the viewer stream. Not agent-scoped: it is the public picture of the world. */
  frames(): { epoch: string; t: number; rosterRev: number; b: PoseTuple[]; say: SayEvent[] } {
    const b: PoseTuple[] = [];
    for (const s of this.sessions.values()) b.push(encodePose(s.n, s.body.pose()));
    const say = this.says.filter((e) => this.sim.t - e.t <= SAY_STREAM_TTL_S).map((e) => ({ ...e, text: e.text.slice(0, 140) }));
    return { epoch: this.epoch, t: round(this.sim.t, 3), rosterRev: this.rosterRev, b, say };
  }

  /** Body number -> agent id (gateway-side only: it turns this into a display name) and the body model to draw. */
  roster(): { epoch: string; rev: number; bodies: { n: number; agentId: string; body: string }[] } {
    return { epoch: this.epoch, rev: this.rosterRev, bodies: [...this.sessions].map(([agentId, s]) => ({ n: s.n, agentId, body: s.figure })) };
  }

  /** The named places an agent may `go_to`: ids and names only (positions are perceived through `observe`).
   *  A shopfront's interior `room` id rides along (null when the place has none): it is the
   *  alternate `go_to` address for the same door, enumerable here so a cold agent can
   *  discover room targets from the API instead of only from observe's near-range doors. */
  places(): { id: string; name: string; kind: string; room: string | null }[] {
    return this.sim.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind, room: p.room ?? null }));
  }

  /** The clips `play` accepts: name, whether it loops (held for `seconds`), and its own length in seconds. */
  clips(): { name: string; loop: boolean; seconds: number; seatedOk: boolean; aliases: string[] }[] {
    return SOCIAL_CLIPS.map((name) => {
      const d = clipDef(name);
      return { name, loop: d?.loop ?? false, seconds: round(d?.duration ?? 0, 2), seatedOk: !!d?.seatedOk, aliases: d?.aliases ?? [] };
    });
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
