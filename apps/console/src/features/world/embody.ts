// embody.ts — Embody v0 skill layer (SPIKE, branch tmp/embody-v0).
//
// Design note: EMBODY-V0-DESIGN-2026-11-04.md in the AIVerse goal files.
// Three layers: the mind (an LLM in the gateway) picks intent from a
// small skill menu; this module executes skills against a BodyPort (the
// console's Recast crowd); the body layer owns steering, turn rates and
// clip blending. The agent never emits angles or per-frame commands.
//
// Three-free and DOM-free, same discipline as locomotion.ts: positions
// are crowd-space [x, z] pairs and heading follows the locomotion
// convention (heading = atan2(vx, vz); facing vector = (sin h, cos h)).
// The executor runs headless under vitest against a fake body.

export type Vec2 = [number, number];

/** A Smart Object anchor: a piece of furniture advertising an interaction. */
export interface Anchor {
  id: string;
  label: string;
  /** Seat position in crowd space; the figure renders here while seated. */
  seat: Vec2;
  /** Heading the seated figure faces, radians. */
  facing: number;
  /** Stand point in front of the seat: the body navigates here, faces
   * the bench, turns its back to it and mounts backwards onto the seat. */
  approach: Vec2;
  /** Seat surface height above the ground plane, m (render lift). */
  seatHeight: number;
  occupiedBy: number | null;
}

/** How far in FRONT of the seat centre the sit_on stand point sits, m.
 * The sitter walks to the front of the bench, faces it, turns around
 * and backs onto the seat — she never enters through the bench. 0.62 m
 * clears the seat's front edge (seat depth 0.45 → half-depth 0.225)
 * plus the agent's own radius, and the point stands on open deck in
 * front of the carved bench footprint. */
export const STAND_OFF = 0.62;

function anchorFacingCentre(id: string, label: string, angleDeg: number, radius: number, seatHeight: number): Anchor {
  const t = (angleDeg * Math.PI) / 180;
  const seat: Vec2 = [Math.cos(t) * radius, Math.sin(t) * radius];
  // Face the deck centre: facing direction is -seat normalized, and the
  // heading whose facing vector (sin h, cos h) matches it.
  const facing = Math.atan2(-seat[0], -seat[1]);
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  // The stand point is in FRONT of the seat, along the facing: the
  // point the body navigates to before the face-turn-mount sequence,
  // and the point stand returns to.
  const approach: Vec2 = [seat[0] + fx * STAND_OFF, seat[1] + fz * STAND_OFF];
  return { id, label, seat, facing, approach, seatHeight, occupiedBy: null };
}

/**
 * Spike anchors on the Agora deck (annulus 2.2–9.7 m at r = 5.2, facing
 * the hologlobe). Placeholder coordinates until bench positions are
 * measured from the Blender scene; the spike renders a stand-in bench at
 * each anchor so the Smart Object and its anchor arrive together.
 */
export const AGORA_BENCH_ANCHORS: Anchor[] = [
  anchorFacingCentre("bench-a", "Bench A", 35, 5.2, 0.45),
  anchorFacingCentre("bench-b", "Bench B", 215, 5.2, 0.45),
];

export interface BodyFrame {
  position: Vec2;
  speed: number;
  heading: number;
}

/** The body layer the executor drives — implemented over the Recast crowd. */
export interface BodyPort {
  frame(index: number): BodyFrame | null;
  setControlled(index: number, on: boolean): void;
  moveTo(index: number, x: number, z: number): void;
  stop(index: number): void;
  setHeading(index: number, heading: number): void;
}

export type SkillRequest =
  | { skill: "go_to"; target: Vec2 }
  | { skill: "face"; target: { heading: number } | { point: Vec2 } | { agent: number } }
  | { skill: "stop" }
  | { skill: "sit_on"; anchorId: string }
  | { skill: "stand" };

export interface EmbodyEvent {
  t: number;
  agent: number;
  type: "started" | "completed" | "failed" | "cancelled" | "refused";
  skill: string;
  detail?: string;
}

/**
 * Which leg of the sit/stand transition an override belongs to. The
 * figure layer plays a different clip per phase (see bodies.ts
 * sitClipForPhase): mounting plays SitDown forward, seated loops
 * SittingTalking, standing plays the dedicated StandUp clip forward.
 */
export type SitPhase = "mounting" | "seated" | "standing";

/** Render transform override for one figure (crowd space + lift). */
export interface FigureOverride {
  position: Vec2;
  /** Height above the ground plane, m. */
  y: number;
  heading: number;
  phase: SitPhase;
}

export const TURN_RATE = Math.PI; // 180 deg/s
export const FACE_DONE_RAD = (5 * Math.PI) / 180;
export const ARRIVE_RADIUS = 0.35; // m — tighter than the crowd's wander arrival: a skill means the spot
export const BLOCKED_AFTER_S = 4; // stationary and unarrived this long => blocked
export const MOUNT_S = 0.6; // legacy slide time — superseded by SIT_DOWN_S / STAND_UP_S
export const SIT_DOWN_S = 2.2333; // s — SitDown clip length: the dedicated Mixamo stand_to_sit transition (authored span 67 frames @ 30 fps, rescaled to 24 fps); the mount slide syncs to it so the root drop lands with the clip's descent
export const STAND_UP_S = 2.2667; // s — StandUp clip length: the dedicated sit_to_stand transition (68 frames @ 30 fps, rescaled); the stand slide syncs to it
export const CAST_HIPS_Y = 0.6531; // m — cast rig's standing hips height, measured in Blender from cast-bodyblock.glb

/**
 * Root Y of a figure seated on anchor `a`. The sitting clips carry
 * rotations only (their hips-location channels were stripped at bake
 * time), so the override drops the whole figure by the difference
 * between the rig's standing hips height and the seat top — the pelvis
 * lands on the seat and the bent legs reach the floor (proof-rendered
 * at this exact offset). `hipsY` is the MEMBER's body hips height
 * (bodies.ts registry); it defaults to the cast body's.
 */
export function seatedRootY(a: Anchor, hipsY: number = CAST_HIPS_Y): number {
  return a.seatHeight - hipsY;
}
export const NEARBY_RADIUS = 6; // m — context surface: interactables offered within this range

/** Shortest signed angular distance from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rotate `from` toward `to` by at most maxStep radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

type Posture = "standing" | "seated";

type RunningSkill =
  | { name: "go_to"; target: Vec2; lastMoveAt: number }
  | { name: "face"; targetHeading: number }
  | { name: "sit_on"; anchor: Anchor; phase: "goto" | "face" | "turn" | "mount"; phaseT: number; from: Vec2; lastMoveAt: number }
  | { name: "stand"; anchor: Anchor; phaseT: number };

interface AgentState {
  posture: Posture;
  heading: number;
  current: RunningSkill | null;
  override: FigureOverride | null;
  seatedAnchor: Anchor | null;
  controlled: boolean;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp2 = (a: Vec2, b: Vec2, k: number): Vec2 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

export class EmbodyController {
  readonly events: EmbodyEvent[] = [];
  private states = new Map<number, AgentState>();
  private clock = 0;

  private port: BodyPort;
  readonly anchors: Anchor[];
  /** Standing hips height per agent index — members wear different
   * bodies (bodies.ts), and the seat drop uses the wearer's own hips. */
  private hipsYFor: (index: number) => number;

  constructor(port: BodyPort, anchors: Anchor[], opts?: { hipsYFor?: (index: number) => number }) {
    this.port = port;
    this.anchors = anchors;
    this.hipsYFor = opts?.hipsYFor ?? (() => CAST_HIPS_Y);
  }

  /** Seated root Y for one agent on one anchor, in the agent's body. */
  private rootY(index: number, a: Anchor): number {
    return seatedRootY(a, this.hipsYFor(index));
  }

  private log(agent: number, type: EmbodyEvent["type"], skill: string, detail?: string): void {
    this.events.push({ t: this.clock, agent, type, skill, detail });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  private state(index: number): AgentState {
    let s = this.states.get(index);
    if (!s) {
      const f = this.port.frame(index);
      s = {
        posture: "standing",
        heading: f ? f.heading : 0,
        current: null,
        override: null,
        seatedAnchor: null,
        controlled: false,
      };
      this.states.set(index, s);
    }
    if (!s.controlled) {
      // First contact: take the body off wander so skills own it.
      this.port.setControlled(index, true);
      s.controlled = true;
    }
    return s;
  }

  /** Issue a skill. Refusals come back as events AND a false return. */
  issue(index: number, req: SkillRequest): boolean {
    const s = this.state(index);
    const refuse = (detail: string): boolean => {
      this.log(index, "refused", req.skill, detail);
      return false;
    };

    if (req.skill === "stop") {
      if (s.current) {
        this.log(index, "cancelled", s.current.name, "stop issued");
        s.current = null;
      }
      // Cancelling a mount mid-slide: drop the override (the crowd body
      // never left the approach point, so the figure returns to it).
      if (s.posture === "standing") s.override = null;
      this.port.stop(index);
      this.log(index, "completed", "stop");
      return true;
    }

    if (s.current) return refuse(`busy: ${s.current.name} in progress`);
    if (s.posture === "seated" && (req.skill === "go_to" || req.skill === "sit_on")) {
      return refuse("seated — stand first");
    }

    switch (req.skill) {
      case "go_to": {
        s.current = { name: "go_to", target: req.target, lastMoveAt: this.clock };
        this.port.moveTo(index, req.target[0], req.target[1]);
        this.log(index, "started", "go_to", `-> [${req.target[0].toFixed(1)}, ${req.target[1].toFixed(1)}]`);
        return true;
      }
      case "face": {
        const targetHeading = this.resolveFaceTarget(index, req.target);
        if (targetHeading === null) return refuse("face target not found");
        s.current = { name: "face", targetHeading };
        this.log(index, "started", "face");
        return true;
      }
      case "sit_on": {
        const anchor = this.anchors.find((a) => a.id === req.anchorId);
        if (!anchor) return refuse(`unknown anchor ${req.anchorId}`);
        if (anchor.occupiedBy !== null && anchor.occupiedBy !== index) {
          return refuse(`occupied by agent ${anchor.occupiedBy}`);
        }
        const f = this.port.frame(index);
        s.current = {
          name: "sit_on",
          anchor,
          phase: "goto",
          phaseT: 0,
          from: f ? f.position : anchor.approach,
          lastMoveAt: this.clock,
        };
        this.port.moveTo(index, anchor.approach[0], anchor.approach[1]);
        this.log(index, "started", "sit_on", anchor.id);
        return true;
      }
      case "stand": {
        if (s.posture !== "seated" || !s.seatedAnchor) return refuse("not seated");
        s.current = { name: "stand", anchor: s.seatedAnchor, phaseT: 0 };
        this.log(index, "started", "stand", s.seatedAnchor.id);
        return true;
      }
    }
  }

  private resolveFaceTarget(
    index: number,
    target: { heading: number } | { point: Vec2 } | { agent: number },
  ): number | null {
    if ("heading" in target) return target.heading;
    const f = this.port.frame(index);
    if (!f) return null;
    if ("point" in target) {
      return Math.atan2(target.point[0] - f.position[0], target.point[1] - f.position[1]);
    }
    const other = this.port.frame(target.agent);
    if (!other) return null;
    return Math.atan2(other.position[0] - f.position[0], other.position[1] - f.position[1]);
  }

  tick(dt: number): void {
    this.clock += dt;
    for (const [index, s] of this.states) {
      const cur = s.current;
      if (!cur) {
        // Seated and idle: the override holds the seat, heading follows
        // the agent's own facing state (face skills still land here).
        if (s.posture === "seated" && s.override) s.override.heading = s.heading;
        continue;
      }
      const f = this.port.frame(index);

      if (cur.name === "go_to") {
        if (!f) continue;
        if (dist(f.position, cur.target) <= ARRIVE_RADIUS) {
          this.port.stop(index);
          s.current = null;
          this.log(index, "completed", "go_to");
        } else if (f.speed >= 0.05) {
          cur.lastMoveAt = this.clock;
        } else if (this.clock - cur.lastMoveAt > BLOCKED_AFTER_S) {
          s.current = null;
          this.port.stop(index);
          this.log(index, "failed", "go_to", "blocked: no progress");
        }
      } else if (cur.name === "face") {
        if (this.turnStep(s, index, cur.targetHeading, dt)) {
          s.current = null;
          this.log(index, "completed", "face");
        }
      } else if (cur.name === "sit_on") {
        this.tickSitOn(index, s, cur, f, dt);
      } else if (cur.name === "stand") {
        cur.phaseT += dt;
        const k = Math.min(1, cur.phaseT / STAND_UP_S);
        const a = cur.anchor;
        s.override = {
          position: lerp2(a.seat, a.approach, k),
          y: this.rootY(index, a) * (1 - k),
          heading: s.heading,
          phase: "standing",
        };
        if (k >= 1) {
          s.override = null;
          s.posture = "standing";
          a.occupiedBy = null;
          s.seatedAnchor = null;
          s.current = null;
          this.log(index, "completed", "stand", a.id);
        }
      }
    }
  }

  private tickSitOn(
    index: number,
    s: AgentState,
    cur: Extract<RunningSkill, { name: "sit_on" }>,
    f: BodyFrame | null,
    dt: number,
  ): void {
    const a = cur.anchor;
    if (cur.phase === "goto") {
      if (!f) return;
      if (dist(f.position, a.approach) <= ARRIVE_RADIUS) {
        this.port.stop(index);
        cur.phase = "face";
      } else if (f.speed >= 0.05) {
        cur.lastMoveAt = this.clock;
      } else if (this.clock - cur.lastMoveAt > BLOCKED_AFTER_S) {
        s.current = null;
        this.port.stop(index);
        this.log(index, "failed", "sit_on", "blocked: no progress to the approach point");
      }
      return;
    }
    if (cur.phase === "face") {
      // At the stand point, first FACE the bench (heading opposite the
      // seat facing) — you look at the thing you are about to sit on.
      if (this.turnStep(s, index, a.facing + Math.PI, dt)) {
        cur.phase = "turn";
      }
      return;
    }
    if (cur.phase === "turn") {
      // Then turn in place 180° so the back is to the bench; the mount
      // backs onto the seat from the front, never through it.
      if (this.turnStep(s, index, a.facing, dt)) {
        cur.phase = "mount";
        cur.phaseT = 0;
        const fr = this.port.frame(index);
        cur.from = fr ? fr.position : a.approach;
      }
      return;
    }
    // mount: slide BACKWARD from the stand point onto the seat (the
    // segment stays in the front hemisphere of the seat), synced to
    // the SitDown clip — the root drop lands as the clip's descent ends.
    cur.phaseT += dt;
    const k = Math.min(1, cur.phaseT / SIT_DOWN_S);
    s.override = {
      position: lerp2(cur.from, a.seat, k),
      y: this.rootY(index, a) * k,
      heading: a.facing,
      phase: k >= 1 ? "seated" : "mounting",
    };
    s.heading = a.facing;
    if (k >= 1) {
      s.posture = "seated";
      s.seatedAnchor = a;
      a.occupiedBy = index;
      s.current = null;
      this.log(index, "completed", "sit_on", a.id);
    }
  }

  /** One turn step toward a heading; returns true when within tolerance. */
  private turnStep(s: AgentState, index: number, targetHeading: number, dt: number): boolean {
    if (Math.abs(angleDelta(s.heading, targetHeading)) <= FACE_DONE_RAD) {
      s.heading = targetHeading;
      this.port.setHeading(index, s.heading);
      return true;
    }
    s.heading = turnToward(s.heading, targetHeading, TURN_RATE * dt);
    this.port.setHeading(index, s.heading);
    return false;
  }

  /** Current render override for a figure, or null when the crowd owns it. */
  overrideFor(index: number): FigureOverride | null {
    return this.states.get(index)?.override ?? null;
  }

  stateFor(index: number): { posture: Posture; current: string | null; heading: number } {
    const s = this.states.get(index);
    if (!s) return { posture: "standing", current: null, heading: 0 };
    return { posture: s.posture, current: s.current ? s.current.name : null, heading: s.heading };
  }

  /**
   * The context surface the mind will read (design note): what this
   * agent is doing, and which interactables are actually in reach —
   * affordance-gated, ids enumerated, nothing free-text.
   */
  contextFor(index: number): {
    posture: Posture;
    current_action: string | null;
    nearby_interactables: { id: string; label: string; distance: number; free: boolean }[];
  } {
    const s = this.state(index);
    const f = this.port.frame(index);
    const nearby = f
      ? this.anchors
          .map((a) => ({ id: a.id, label: a.label, distance: dist(f.position, a.seat), free: a.occupiedBy === null }))
          .filter((a) => a.distance <= NEARBY_RADIUS)
      : [];
    return {
      posture: s.posture,
      current_action: s.current ? s.current.name : null,
      nearby_interactables: nearby,
    };
  }
}
