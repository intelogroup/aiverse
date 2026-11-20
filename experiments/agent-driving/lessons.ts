import { COURSE, DRIVER, type Check, type Direction, type DriveAction, type DriveState, type HeadlightMode, type LessonId } from "./protocol";
import type { Recovery } from "./driver";
import { benchmarkCase, type BenchmarkId } from "./benchmark";
import { senseFeed, type SenseFeed } from "./senses";

export const lessons = {
  lane_change: { title: "Change lanes left", goal: "Move into the adjacent left lane and stop centered in it." },
  lane_change_right: { title: "Change lanes right", goal: "Move into the adjacent right lane and stop centered in it." },
  three_point: { title: "Three-point turn", goal: "Turn around between the curbs and stop in the proper lane facing the opposite way." },
  right_turn: { title: "Right turn at a stop sign", goal: "Turn right at the intersection and stop in the correct departure lane." },
  left_turn: { title: "Left turn with oncoming traffic", goal: "Turn left at the intersection and stop in the correct departure lane." },
  no_turn_on_red: { title: "Signed red light", goal: "Turn right at the next intersection and stop in the correct departure lane." },
  crosswalk: { title: "Signal and crosswalk", goal: "Turn right at the next intersection and stop in the correct departure lane." },
} satisfies Record<LessonId, { title: string; goal: string }>;

export const LESSON_ROAD = {
  laneCenter: 1.9,
  curb: COURSE.halfRoad,
  intersection: COURSE.crossingZ,
  stopLine: COURSE.yieldLineZ,
  crosswalkX: -7.95,
  signX: -5.3,
} as const;
const { laneCenter, curb, intersection, stopLine } = LESSON_ROAD;
const stopZ = stopLine - DRIVER.halfLength - COURSE.lineMarginMeters;
const spawnZ = -34;
const localSignalDistance = 30.48;
const maxAcceleration = 3.6;
const maxBraking = 6.5;
const headingTolerance = 0.002;

type Hazard = "blind_spot_vehicle" | "oncoming_vehicle" | "red_light" | "pedestrian";
type Actor = { x: number; z: number; heading: number; kind: "vehicle" | "pedestrian" };
type Pose = Pick<DriveState, "x" | "z" | "heading">;
type Segment = { meters: number; curvature: number; speed: number };
type Rejection = { code: string; error: string; recovery?: Recovery };
type Plan = { segments: Segment[]; detail: string; commit: () => void } | { seconds: number; detail: string; commit: () => void };
type ActiveLesson = { plan: Plan; elapsed: number; segment: number; remaining: number };
export type LessonState = {
  id: LessonId;
  road: "one_way" | "two_way";
  laneDivider: "broken_white" | "unmarked" | "double_yellow";
  signalHead: "red" | "yellow" | "green" | null;
  sign: "STOP" | "NO TURN ON RED" | null;
  crosswalk: boolean;
  hazard: Hazard | null;
  actor: Actor | null;
  checked: Check | null;
  indicator: Direction | null;
  gear: "drive" | "reverse";
  stoppedAtLine: boolean;
  legs: number;
  evidence: string[];
  passed: boolean;
  benchmark?: BenchmarkId;
  senses?: SenseFeed;
  exam: boolean;
  realtime: boolean;
  reflex: boolean;
  infractions: Infraction[];
  laneChanged?: boolean;
  oncoming?: Actor;
};

const reject = (code: string, error: string, recovery?: Recovery): Rejection => ({ code, error, recovery });
export type Infraction = { code: string };
// realtime: the approach runs on the clock without blocking the caller. reflex: the car stops at the line by itself.
// turnsRed: the light goes yellow then red while the car approaches.
export type LessonOptions = { realtime?: boolean; reflex?: boolean; turnsRed?: boolean };
const checkRecovery = (area: Check): Recovery => ({ tool: "drive_check", arguments: { area } });
const signalRecovery = (direction: Direction): Recovery => ({ tool: "drive_signal", arguments: { direction } });
const waitRecovery: Recovery = { tool: "drive_wait", arguments: {} };
const straight = (meters: number, speed = 5): Segment => ({ meters, curvature: 0, speed });
const arc = (radius: number, angle: number, reverse = false, speed = 2.7): Segment => ({
  meters: Math.abs(radius * angle) * (reverse ? -1 : 1),
  curvature: Math.sign(angle) * (reverse ? -1 : 1) / radius,
  speed,
});

export function isLaneChange(id: LessonId) {
  return id === "lane_change" || id === "lane_change_right";
}

export function isIntersectionLesson(id: LessonId) {
  return !isLaneChange(id) && id !== "three_point";
}

export function lessonSpawn(id: LessonId, benchmark?: BenchmarkId): Pose {
  if (benchmark) {
    const course = benchmarkCase(benchmark);
    return { x: course.chapter === "route" ? laneCenter : -laneCenter, z: (course.chapter === "route" ? -52 : spawnZ) + course.shift, heading: 0 };
  }
  const x = id === "three_point" ? -4.3 : id === "lane_change_right" ? laneCenter : -laneCenter;
  return { x, z: isIntersectionLesson(id) ? spawnZ : -23, heading: 0 };
}

function insideRoad({ x, z, heading }: Pose, { id, benchmark }: LessonState) {
  const course = benchmark ? benchmarkCase(benchmark) : undefined;
  const branchZ = intersection + (course?.shift ?? 0);
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  for (const length of [-DRIVER.halfLength, DRIVER.halfLength]) {
    for (const width of [-DRIVER.halfWidth, DRIVER.halfWidth]) {
      const px = x + sin * length + cos * width;
      const pz = z + cos * length - sin * width;
      const main = Math.abs(px) <= curb && pz >= (course?.chapter === "route" ? -57 : COURSE.south - 3) && pz <= COURSE.north;
      const branch = isIntersectionLesson(id) && Math.abs(pz - branchZ) <= COURSE.crossingHalfWidth
        && px >= COURSE.west && px <= COURSE.east;
      if (!main && !branch) return false;
    }
  }
  return true;
}

function advance({ x, z, heading }: Pose, meters: number, curvature: number): Pose {
  const next = heading + meters * curvature;
  return curvature ? {
    x: x + (Math.cos(heading) - Math.cos(next)) / curvature,
    z: z + (Math.sin(next) - Math.sin(heading)) / curvature,
    heading: next,
  } : { x: x + Math.sin(heading) * meters, z: z + Math.cos(heading) * meters, heading };
}

function fixture(id: LessonId, hazard: Hazard | null, progress = 0): Actor | null {
  if (hazard === "blind_spot_vehicle") return { x: -lessonSpawn(id).x, z: -28.2 + progress * 34, heading: 0, kind: "vehicle" };
  if (hazard === "oncoming_vehicle") return { x: laneCenter, z: 22 - progress * 56, heading: Math.PI, kind: "vehicle" };
  if (hazard === "pedestrian") return { x: LESSON_ROAD.crosswalkX, z: 6.35 + progress * 6, heading: 0, kind: "pedestrian" };
  return null;
}

export class LessonRun {
  private readonly state: LessonState;
  private signalZ: number | undefined;
  private active: ActiveLesson | undefined;
  private interrupted = false;
  private readonly course: ReturnType<typeof benchmarkCase> | undefined;
  private walkerPending = false;
  private turnsRed = false;
  private clock = 0;
  private signalPlan: { yellowAt: number; redAt: number } | undefined;
  private watchLine = false;
  private crossedLine = false;

  constructor(id: LessonId, benchmark?: BenchmarkId, exam = false, options: LessonOptions = {}) {
    this.turnsRed = Boolean(options.turnsRed);
    const course = this.course = benchmark ? benchmarkCase(benchmark) : undefined;
    const sign = course ? course.posted ? "NO TURN ON RED" : null
      : id === "no_turn_on_red" || id === "crosswalk" ? "NO TURN ON RED" : isIntersectionLesson(id) ? "STOP" : null;
    const laneChange = isLaneChange(id);
    this.walkerPending = Boolean(course?.pedestrian);
    const hazard = course ? this.junctionHazard(course.signal, Boolean(course.posted))
      : laneChange ? "blind_spot_vehicle" : id === "left_turn" ? "oncoming_vehicle" : sign === "NO TURN ON RED" ? "red_light" : null;
    this.state = {
      id, benchmark, exam, realtime: Boolean(options.realtime), reflex: options.reflex !== false, infractions: [], road: laneChange || course?.chapter === "route" ? "one_way" : "two_way",
      laneDivider: laneChange || course?.chapter === "route" ? "broken_white" : id === "three_point" ? "unmarked" : "double_yellow",
      signalHead: course?.signal ?? (sign === "NO TURN ON RED" ? "red" : null),
      sign, crosswalk: Boolean(course) || id === "crosswalk", hazard, actor: null, checked: null,
      indicator: null, gear: "drive", stoppedAtLine: false, legs: 0,
      evidence: course?.preselectedHigh ? ["high_beam_preselected"] : [], passed: false,
      oncoming: course?.preselectedHigh && course.oncoming ? this.oncomingAt(0) : undefined,
    };
    this.state.actor = this.actorAt(0);
  }

  snapshot(car?: Pick<DriveState, "x" | "z" | "heading" | "speed">): LessonState {
    return { ...this.state, evidence: [...this.state.evidence], infractions: [...this.state.infractions], ...(car && { senses: this.senses(car) }) };
  }

  // Instrument feed for an agent that cannot read frames at speed (see senses.ts). Geometry is the lab's own, approximate.
  private senses(car: Pick<DriveState, "x" | "z" | "heading" | "speed">): SenseFeed {
    const s = this.state;
    const shift = this.course?.shift ?? 0;
    const actors = [s.actor, s.oncoming].filter((a): a is Actor => Boolean(a)).map((a) => ({ ...a, moving: Boolean(this.active) || a.kind === "vehicle" && s.hazard === "oncoming_vehicle" }));
    return senseFeed({
      car, frontOffset: DRIVER.halfLength,
      stopLineZ: isIntersectionLesson(s.id) ? stopLine + shift : null,
      crosswalkZ: s.crosswalk ? intersection + shift : null,
      light: s.signalHead, sign: s.sign, actors,
    });
  }

  // Lesson mode refuses an unsafe move and coaches. Exam mode lets it happen and records the infraction, like a road test.
  private violate(code: string, error: string, recovery?: Recovery): Rejection | undefined {
    if (!this.state.exam) return reject(code, error, recovery);
    this.state.infractions.push({ code });
  }

  private record(evidence: string) {
    this.state.evidence.push(evidence);
  }

  private junctionHazard(signal: LessonState["signalHead"], posted: boolean): Hazard | null {
    if (signal === "red" && posted) return "red_light";
    return this.walkerPending ? "pedestrian" : null;
  }

  private actorAt(progress: number) {
    const { course, state } = this;
    if (course && this.walkerPending) {
      return { kind: "pedestrian" as const, x: course.crosswalkX, z: course.shift + course.pedestrianZ + progress * (12.4 - course.pedestrianZ), heading: 0 };
    }
    return fixture(state.id, state.hazard, progress);
  }

  private oncomingAt(progress: number): Actor {
    return { x: laneCenter, z: intersection + (this.course?.shift ?? 0) + 6 - progress * 30, kind: "vehicle", heading: Math.PI };
  }

  headlights(beam: HeadlightMode, previous: HeadlightMode): Rejection | undefined {
    if (this.course?.chapter !== "night") return;
    if (beam === "high" && this.state.oncoming) { const r = this.violate("high_beam_conflict", "Dim the high beams for the approaching driver."); if (r) return r; }
    if (beam === "high" && !this.state.evidence.includes("high_beam_in_open_road")) this.record("high_beam_in_open_road");
    if (beam === "low" && previous === "high" && this.state.oncoming) this.record("dimmed_for_oncoming");
  }

  begin(input: DriveAction, state: DriveState): string | Rejection | undefined {
    const plan = this.plan(input, state);
    if (typeof plan === "string" || "error" in plan) return plan;
    if ("segments" in plan) {
      let pose: Pose = state;
      for (const { meters, curvature } of plan.segments) {
        const samples = Math.ceil(Math.abs(meters) / 0.1);
        for (let i = 1; i <= samples; i++) {
          if (!insideRoad(advance(pose, meters * i / samples, curvature), this.state)) {
            return reject("curb_contact", "That path would put a wheel or bumper beyond the curb.");
          }
        }
        pose = advance(pose, meters, curvature);
      }
      this.state.gear = plan.segments[0].meters < 0 ? "reverse" : "drive";
    }
    this.active = { plan, elapsed: 0, segment: 0, remaining: "segments" in plan ? Math.abs(plan.segments[0].meters) : 0 };
  }

  private plan(input: DriveAction, car: DriveState): Plan | string | Rejection {
    const s = this.state;
    const course = this.course;
    const routeLane = course?.chapter === "route" && !s.laneChanged;
    const expectedTurn = s.id === "left_turn" ? "left" : "right";
    const hasApproach = isIntersectionLesson(s.id);
    const expectedCheck: Check = routeLane || isLaneChange(s.id) ? "mirrors_and_blind_spot" : hasApproach ? "intersection"
      : s.legs === 1 ? "rear_and_both_directions" : "both_directions";
    if (this.interrupted) return reject("lesson_interrupted", "Reset the drill after interrupting a maneuver.");
    if (s.passed) return reject("lesson_complete", "The maneuver is already verified.");
    if (input.command === "check" && input.check) {
      if (input.check !== expectedCheck) return reject("wrong_check_area", "That view does not cover the current maneuver.", checkRecovery(expectedCheck));
      s.checked = input.check;
      return "Check complete. Read the current road, traffic, and control observations.";
    }
    if (input.command === "signal" && input.direction) {
      if (s.indicator !== input.direction) this.signalZ = car.z;
      s.indicator = input.direction;
      return `${input.direction === "left" ? "Left" : "Right"} turn signal on.`;
    }
    if (input.command === "wait") {
      const hazard = s.hazard ?? (s.oncoming ? "oncoming_vehicle" : course && s.signalHead === "red" ? "red_light" : null);
      if (!hazard || (hasApproach && !s.stoppedAtLine)) return reject("nothing_to_yield_to", "Wait from a safe stopped position when a hazard is present.");
      if (s.oncoming && car.headlights === "high") { const r = this.violate("high_beam_conflict", "Dim the high beams for the approaching driver even while stopped."); if (r) return r; }
      return {
        seconds: hazard === "red_light" ? 2.5 : hazard === "pedestrian" ? 5.5 : 4,
        detail: hazard === "red_light" ? "Signal changed to green. Check the intersection again." : "The conflict cleared. Earlier checks are stale. Recheck before moving.",
        commit: () => {
          if (hazard === "red_light") s.signalHead = "green";
          this.record(hazard === "red_light" ? "held_on_red" : `yielded_to_${hazard}`);
          s.oncoming = undefined;
          if (hazard === "pedestrian") this.walkerPending = false;
          s.hazard = course ? this.junctionHazard(s.signalHead, Boolean(course.posted))
            : hazard === "red_light" && s.crosswalk ? "pedestrian" : null;
          s.actor = this.actorAt(0);
          s.checked = null;
        },
      };
    }
    if (input.command === "approach_lesson" && hasApproach && !s.stoppedAtLine) {
      if (routeLane) {
        const r = this.violate("wrong_turn_lane", "The lane markings assign this lane a different movement. Inspect the arrows and find the lane marked for your turn.", {
          tool: "drive_look", arguments: { view: "road" },
        });
        if (r) return r;
        s.laneChanged = true; // exam: the car stays in the wrong lane; later checks are judged from where it is
      }
      if (course?.chapter === "night" && car.headlights === "off") { const r = this.violate("headlights_required", "Switch on your headlights before driving in darkness."); if (r) return r; }
      if (s.oncoming && car.headlights === "high") { const r = this.violate("high_beam_conflict", "Dim the high beams for the approaching driver before moving."); if (r) return r; }
      if (s.indicator !== expectedTurn || this.signalZ === undefined) {
        const r = this.violate("signal_before_approach", `Signal ${expectedTurn} before approaching the junction so other road users have advance notice.`, signalRecovery(expectedTurn));
        if (r) return r;
        this.signalZ = car.z; // exam: no advance signal was given; the late-signal check below will judge the turn
      }
      const speed = input.speed ?? 5;
      const toLine = stopZ + (course?.shift ?? 0) + (course?.stopOffset ?? 0) - car.z;
      if (s.realtime && this.turnsRed) {
        // A seeded dilemma: yellow once half the expected arrival time has passed, red 3.5 s later (RMV: yellow means prepare to stop).
        const arrival = toLine / speed + speed / (2 * maxAcceleration);
        this.signalPlan = { yellowAt: this.clock + arrival * 0.5, redAt: this.clock + arrival * 0.5 + 3.5 };
      }
      this.watchLine = s.realtime && !s.reflex;
      this.crossedLine = false;
      return {
        segments: [straight(s.realtime && !s.reflex ? toLine + 8 : toLine, speed)],
        detail: s.realtime && !s.reflex ? "Rolled through the junction mouth." : "Stopped fully before the line.",
        commit: () => {
          if (this.watchLine) { this.watchLine = false; this.state.checked = null; return; }
          s.stoppedAtLine = true;
          s.checked = null;
          this.record("full_stop_before_line");
          if (course?.oncoming) s.oncoming = this.oncomingAt(0);
        },
      };
    }
    if (input.command === "change_lane" && (isLaneChange(s.id) || routeLane)) {
      const target = s.id === "lane_change" ? "left" : "right";
      if (input.direction !== target) return reject("no_adjacent_lane", `The adjacent same-direction lane is on the ${target}.`);
      if (s.hazard === "blind_spot_vehicle") { const r = this.violate("blind_spot_occupied", "A vehicle occupies the target lane gap. Wait and check again.", waitRecovery); if (r) return r; }
      if (s.checked !== expectedCheck) { const r = this.violate("check_target_lane", "Check mirrors and the target-side blind spot first.", checkRecovery(expectedCheck)); if (r) return r; }
      if (s.indicator !== input.direction) { const r = this.violate("signal_required", "Signal toward the target lane before moving.", signalRecovery(target)); if (r) return r; }
      const radius = routeLane ? 10 : 13;
      const angle = (target === "left" ? 1 : -1) * Math.acos(1 - laneCenter / radius);
      return {
        segments: [arc(radius, angle), arc(radius, -angle), straight(2, 2.7)],
        detail: "Changed lanes and stopped centered and aligned.",
        commit: () => {
          this.record("checked_lane_and_signaled");
          this.record("centered_in_target_lane");
          s.indicator = null;
          s.checked = null;
          if (routeLane) s.laneChanged = true;
          else s.passed = true;
        },
      };
    }
    if (input.command === "three_point" && s.id === "three_point") {
      if (s.checked !== expectedCheck) {
        const r = this.violate("check_each_leg", s.legs === 1
          ? "Check behind over the right shoulder and both directions before reversing."
          : "Check both directions, including the blind spot, before the forward leg.",
        checkRecovery(expectedCheck));
        if (r) return r;
      }
      if (s.legs !== 1 && s.indicator !== "left") { const r = this.violate("signal_required", "Signal left on this forward leg.", signalRecovery("left")); if (r) return r; }
      const segments = [
        [arc(7.35, Math.PI / 2, false, 2.1)],
        [arc(7.35, Math.PI / 6, true, 1.6), straight(-2.6, 1.6)],
        [arc((laneCenter - car.x) / 0.5, Math.PI / 3, false, 2.1)],
      ][s.legs];
      return {
        segments,
        detail: ["First forward leg stopped before the far curb.", "Reverse leg stopped before the near curb.", "Facing the opposite direction in the correct lane." ][s.legs],
        commit: () => {
          this.record(["forward_to_far_curb", "reverse_to_near_curb", "forward_in_opposite_lane"][s.legs]);
          s.legs++;
          s.checked = null;
          s.indicator = null;
          s.passed = s.legs === 3;
        },
      };
    }
    if (input.command === "intersection_turn" && hasApproach) {
      if (input.direction !== expectedTurn) {
        return reject("wrong_destination", "Turn onto the road requested in the lesson.");
      }
      if (!s.stoppedAtLine) { const r = this.violate("stop_before_line", "Approach the junction and come to a full stop before the line."); if (r) return r; }
      if (s.signalHead === "red" && s.sign === "NO TURN ON RED") { const r = this.violate("posted_no_turn_on_red", "The posted NO TURN ON RED sign applies. Hold before the stop line until green.", waitRecovery); if (r) return r; }
      if (s.hazard === "pedestrian") { const r = this.violate("crosswalk_occupied", "The marked crosswalk is occupied, including on green. Wait behind the stop line.", waitRecovery); if (r) return r; }
      if (s.hazard === "oncoming_vehicle") { const r = this.violate("yield_to_oncoming", "Oncoming traffic has priority. Wait for a clear gap.", waitRecovery); if (r) return r; }
      if (course?.chapter === "night" && car.headlights === "off") { const r = this.violate("headlights_required", "Switch on your headlights before moving in darkness."); if (r) return r; }
      if (s.oncoming && car.headlights === "high") { const r = this.violate("high_beam_conflict", "Dim the high beams before moving near the approaching driver."); if (r) return r; }
      if (s.checked !== expectedCheck) { const r = this.violate("check_intersection", "Check traffic, pedestrians, and the intended exit lane from the stop.", checkRecovery(expectedCheck)); if (r) return r; }
      if (s.indicator !== input.direction || this.signalZ === undefined) { const r = this.violate("signal_required", "Set the turn signal before turning."); if (r) return r; }
      const radius = expectedTurn === "left" ? 7.3 : 5.7;
      const turnZ = intersection + (course?.shift ?? 0) + (expectedTurn === "left" ? laneCenter : -laneCenter) - radius;
      if (this.signalZ !== undefined && turnZ - this.signalZ < localSignalDistance) { const r = this.violate("signal_too_late", "Signal at least 100 feet before the turn on this road. Reset the drill to signal earlier."); if (r) return r; }
      return {
        segments: [straight(turnZ - car.z, 2.7), arc(radius, (expectedTurn === "left" ? 1 : -1) * Math.PI / 2), straight(8, 3.2)],
        detail: "Turn complete. Stopped in the proper departure lane.",
        commit: () => {
          if (s.signalHead === "red") this.record("permitted_right_on_red");
          if (course?.chapter === "night" && car.headlights === "low") this.record("finished_night_turn_on_low");
          this.record("checked_intersection");
          this.record("turned_into_proper_lane");
          s.indicator = null;
          s.passed = true;
        },
      };
    }
    return reject("maneuver_unavailable", "This maneuver is unavailable here. Read the lesson observations and use its permitted controls.");
  }

  tick(dt: number, car: DriveState): string | undefined {
    const active = this.active;
    if (!active) return;
    this.clock += dt;
    if (this.signalPlan) {
      const light = this.clock >= this.signalPlan.redAt ? "red" : this.clock >= this.signalPlan.yellowAt ? "yellow" : "green";
      if (light !== this.state.signalHead) {
        this.state.signalHead = light;
        this.state.hazard = this.junctionHazard(light === "yellow" ? "green" : light, Boolean(this.course?.posted));
      }
    }
    const { plan } = active;
    if ("seconds" in plan) {
      active.elapsed += dt;
      car.yielding = true;
      car.braking = true;
      const progress = Math.min(1, active.elapsed / plan.seconds);
      this.state.actor = this.actorAt(this.state.hazard === "pedestrian" || !this.course ? progress : 0);
      if (this.state.oncoming) this.state.oncoming = this.oncomingAt(progress);
      if (progress < 1) return;
    } else {
      const segment = plan.segments[active.segment];
      const direction = Math.sign(segment.meters);
      // Slow for the end of a leg; keep rolling across joined arcs within it.
      const last = active.segment === plan.segments.length - 1;
      const available = last ? active.remaining : active.remaining + Math.abs(plan.segments[active.segment + 1].meters);
      const target = Math.min(segment.speed, Math.sqrt(2 * maxBraking * available));
      const speed = car.speed + Math.max(-maxBraking * dt, Math.min(maxAcceleration * dt, target - car.speed));
      const distance = Math.min(active.remaining, (car.speed + speed) * dt / 2);
      Object.assign(car, advance(car, distance * direction, segment.curvature));
      if (this.watchLine && !this.crossedLine && car.z + DRIVER.halfLength >= stopLine + (this.course?.shift ?? 0)) {
        this.crossedLine = true;
        if (this.state.signalHead === "red") this.state.infractions.push({ code: "ran_red_light" });
        if (car.speed > 0.3) this.state.infractions.push({ code: "stop_before_line" });
      }
      car.wheelRoll += distance * direction / DRIVER.wheelRadius;
      car.steering += (Math.atan(DRIVER.wheelbase * segment.curvature) - car.steering) * Math.min(1, dt * 12);
      car.throttle = speed > car.speed ? 0.55 : 0;
      car.braking = last && speed < car.speed;
      car.speed = speed;
      active.remaining -= distance;
      if (active.remaining > headingTolerance) return;
      if (!last) {
        active.segment++;
        active.remaining = Math.abs(plan.segments[active.segment].meters);
        return;
      }
      car.speed = 0;
    }
    this.active = undefined;
    plan.commit();
    return plan.detail;
  }

  // Realtime: stop short of where the car would otherwise go. The approach is not complete; the agent may approach again.
  brakeNow(car: DriveState): boolean {
    const active = this.active;
    if (!active || "seconds" in active.plan) return false;
    const stopIn = car.speed * car.speed / (2 * maxBraking) + 0.2;
    active.remaining = Math.min(active.remaining, stopIn);
    active.plan = { ...active.plan, detail: "Braked and stopped short of the line.", commit: () => { this.watchLine = false; this.state.checked = null; } };
    active.segment = active.plan.segments.length - 1;
    return true;
  }

  get cruising() { return Boolean(this.active && "segments" in this.active.plan && this.state.realtime); }

  cancel() {
    this.active = undefined;
    this.state.checked = null;
    this.interrupted = true;
  }
}
