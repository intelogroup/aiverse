import { driverRefusal } from "./driver";
import { LessonRun, lessonSpawn } from "./lessons";
import { benchmarkCase, type BenchmarkId } from "./benchmark";
import { COURSE, DRIVER, lessonCommands, stopLineGap, type ActionResult, type Command, type DriveAction, type DriveState, type Event, type LessonId } from "./protocol";

const MAX_SPEED = 8;
const BRAKING = 6.5;
const GAS_ACCELERATION = 3.6;
const BOUNDED_STEERING = 0.6 * 0.58;
const EPSILON = 0.001;

const CROSSING_SPEED = 6.8;
const TRAFFIC_EDGE = COURSE.halfRoad + DRIVER.halfLength;
const TRAFFIC_START_X = -34;
const CROSSING_WINDOW_SECONDS = 5;
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const smooth = (n: number, from: number, to: number) => {
  const t = clamp((n - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
};

export const doorAngle = (phase: DriveState["phase"], t: number) => {
  if (phase === "entering") return DRIVER.doorOpen * (smooth(t, 0.10, 0.34) - smooth(t, 0.77, 0.99));
  if (phase === "exiting") return DRIVER.doorOpen * (smooth(t, 0.03, 0.24) - smooth(t, 0.75, 0.99));
  return 0;
};

function trafficAt(time: number): DriveState["traffic"] {
  const travel = ((time + 7.25) % COURSE.trafficCycleSeconds) * CROSSING_SPEED;
  const x = TRAFFIC_START_X + travel;
  return { x, z: COURSE.crossingZ, visible: x < 34, occupied: Math.abs(x) < TRAFFIC_EDGE, wheelRoll: travel / DRIVER.wheelRadius };
}

function trafficClearForCrossing(traffic: DriveState["traffic"]): boolean {
  if (traffic.occupied) return false;
  const arrivalX = -TRAFFIC_EDGE;
  const distanceUntilArrival = traffic.x < arrivalX
    ? arrivalX - traffic.x
    : COURSE.trafficCycleSeconds * CROSSING_SPEED - traffic.x + arrivalX;
  return distanceUntilArrival >= CROSSING_SPEED * CROSSING_WINDOW_SECONDS;
}

function initialState(trafficOffset: number): DriveState {
  return {
    ...COURSE.spawn, time: trafficOffset, phase: "outside", phaseProgress: 0, heading: 0, speed: 0,
    steering: 0, wheelRoll: 0, door: 0, throttle: 0, braking: false, headlights: "off", yielding: false,
    clearedToCross: false, traffic: trafficAt(trafficOffset), action: null, events: [],
  };
}

type BoundedMotion = {
  remaining: number;
  curvature: number;
  crossing: boolean;
  waitingToDepart: boolean;
};

type Active = {
  input: DriveAction;
  endAt: number;
  started: number;
  clearSince: number | null;
  motion: BoundedMotion | undefined;
  waitedForTraffic: boolean;
  resolve: (result: ActionResult) => void;
};

export class DrivingSimulation {
  private state = initialState(0);
  private active: Active | null = null;
  private sequence = 0;
  private lesson: LessonRun | undefined;
  private brakeHeld = false;

  snapshot(): DriveState {
    return { ...this.state, events: [...this.state.events], lesson: this.lesson?.snapshot(this.state) };
  }

  reset(trafficOffset = 0, lessonId?: LessonId, benchmark?: BenchmarkId, exam = false) {
    const old = this.active;
    this.active = null;
    this.state = initialState(trafficOffset);
    this.brakeHeld = false;
    this.lesson = lessonId ? new LessonRun(lessonId, benchmark, exam) : undefined;
    if (lessonId) {
      Object.assign(this.state, lessonSpawn(lessonId, benchmark));
      if (benchmark && benchmarkCase(benchmark).preselectedHigh) this.state.headlights = "high";
      this.state.traffic = { ...this.state.traffic, visible: false, occupied: false };
    }
    old?.resolve({ ok: false, error: "The course was reset.", state: this.snapshot() });
  }

  actAsDriver(input: DriveAction): Promise<ActionResult> {
    if (this.lesson) {
      if (input.command === "gas" && input.motion && "destination" in input.motion && input.motion.destination === "yield_line") {
        const { motion: _, ...rest } = input;
        return this.act({ ...rest, command: "approach_lesson" });
      }
      return this.act(input);
    }
    const refusal = driverRefusal(input, this.state);
    if (refusal) {
      return Promise.resolve({
        ok: false, error: refusal.message, code: refusal.code,
        recovery: refusal.recovery, state: this.snapshot(),
      });
    }
    return this.act(input);
  }

  act(input: DriveAction): Promise<ActionResult> {
    const { command, seconds, amount, throttle, motion, direction, check, beam } = input;
    const turning = command === "turn_left" || command === "turn_right";
    const state = this.state;
    const reject = (error: string, code?: string): Promise<ActionResult> => Promise.resolve({ ok: false, error, code, state: this.snapshot() });
    if (direction !== undefined && !["signal", "change_lane", "intersection_turn"].includes(command)) return reject("Direction applies to lane changes, signals, and intersection turns.");
    if (check !== undefined && command !== "check") return reject("The view to check applies to a traffic check.");
    if (command === "headlights") {
      if (!beam || motion || throttle !== undefined || seconds !== undefined || amount !== undefined) return reject("Choose an off, low, or high beam setting.");
      if (state.phase !== "driving") return reject("Take the driver's seat before using the headlights.", "driver_not_seated");
      const refusal = this.lesson?.headlights(beam, state.headlights);
      if (refusal) return reject(refusal.error, refusal.code);
      state.headlights = beam;
      const event = this.record(command, "done", beam === "off" ? "Headlights off." : `${beam === "low" ? "Low" : "High"} beams on.`);
      return Promise.resolve({ ok: true, event, state: this.snapshot() });
    }
    if (beam !== undefined) return reject("Set the beam with the headlights control.");
    const lessonAction = (lessonCommands as readonly Command[]).includes(command);
    if (lessonAction || (this.lesson && !["enter", "exit", "brake"].includes(command))) {
      return this.actInLesson(input, lessonAction);
    }
    if (this.lesson && command === "brake" && this.active && this.state.phase === "driving") {
      this.lesson.cancel();
      this.finish("The lesson maneuver was interrupted by the brake. Reset to try again.", true);
    }
    if ((seconds !== undefined || amount !== undefined) && !["gas", "turn_left", "turn_right"].includes(command)) {
      return reject("Seconds and amount apply to gas and turning.");
    }
    if (throttle !== undefined && !turning) return reject("Supplemental throttle applies while turning.");
    if (motion && (seconds !== undefined || amount !== undefined || throttle !== undefined)) {
      return reject("Choose bounded motion or pedal inputs.");
    }
    if (motion && ("degrees" in motion ? !turning : command !== "gas")) {
      return reject("Use degrees with steering or a distance or destination with gas.");
    }
    if (this.active) {
      const canInterrupt = (command === "brake" || command === "yield")
        && ["gas", "turn_left", "turn_right"].includes(this.active.input.command);
      if (!canInterrupt) return reject("A command is in progress. Observe and wait for it to finish.");
      this.finish("Control released to stop the car.", true);
    }
    if (command === "enter" && state.phase !== "outside") return reject("Remy is already in the driver seat.");
    if (command !== "enter" && state.phase !== "driving") return reject("Enter the driver seat first.");
    if (command === "exit" && state.speed > 0) return reject("Brake to a full stop before exiting.");
    if (turning && !motion && state.speed < 0.3 && throttle === undefined) {
      return reject("Apply gas before turning or supply throttle on the turn.");
    }
    let bounded: BoundedMotion | undefined;
    if (motion) {
      const forward = Math.cos(state.heading);
      const crossing = "destination" in motion && motion.destination === "far_side";
      const curvature = "degrees" in motion
        ? Math.tan(BOUNDED_STEERING) / DRIVER.wheelbase * (command === "turn_left" ? 1 : -1)
        : 0;
      if ("destination" in motion && forward < 0.99) {
        return reject("Align the car with the road before driving to the landmark. Aim for heading 0°.");
      }
      if (crossing && (state.z >= COURSE.clearZ || !state.clearedToCross)) {
        return reject("Approach the yield line and yield before driving to the far side.");
      }
      const remaining = "meters" in motion ? motion.meters
        : "degrees" in motion ? motion.degrees * Math.PI / 180 / Math.abs(curvature)
        : crossing ? (COURSE.parkZ - state.z) / forward
        : (stopLineGap(state.z) - COURSE.lineMarginMeters) / forward;
      if (remaining < -EPSILON) return reject("The requested landmark is behind the car.");
      bounded = { remaining: Math.max(0, remaining), curvature, crossing, waitingToDepart: crossing };
    }
    const duration = command === "enter" ? DRIVER.entrySeconds : command === "exit" ? DRIVER.exitSeconds : seconds ?? 1;
    if (command === "exit" || command === "gas" || turning) this.brakeHeld = false;
    return new Promise((resolve) => {
      this.active = {
        input, endAt: state.time + duration, started: state.time, clearSince: null,
        motion: bounded, waitedForTraffic: false, resolve,
      };
      state.action = command;
      if (command === "enter" || command === "exit") {
        state.phase = command === "enter" ? "entering" : "exiting";
        state.phaseProgress = 0;
        state.clearedToCross = false;
      }
      this.record(command, "started", "");
    });
  }

  private actInLesson(input: DriveAction, lessonAction: boolean): Promise<ActionResult> {
    const state = this.state;
    const reject = (code: string, error: string): Promise<ActionResult> => Promise.resolve({ ok: false, error, code, state: this.snapshot() });
    if (!this.lesson) return reject("lesson_required", "Select an RMV driving lesson first.");
    if (!lessonAction) return reject("use_lesson_controls", "Use the lesson maneuver tools. They check road rules before moving.");
    if (state.phase !== "driving") return reject("driver_not_seated", "Take the driver seat first.");
    if (this.active || state.speed !== 0) return reject("maneuver_in_progress", "Finish the current maneuver before calling a lesson tool.");
    if (input.motion || input.seconds !== undefined || input.amount !== undefined || input.throttle !== undefined) {
      return reject("unexpected_input", "Use the parameters defined for this lesson maneuver.");
    }
    const result = this.lesson.begin(input, state);
    if (typeof result === "object") return Promise.resolve({ ok: false, ...result, state: this.snapshot() });
    this.record(input.command, "started", "");
    if (typeof result === "string") {
      const event = this.record(input.command, "done", result);
      return Promise.resolve({ ok: true, event, state: this.snapshot() });
    }
    return new Promise((resolve) => {
      if (input.command !== "wait") this.brakeHeld = false;
      state.action = input.command;
      this.active = { input, started: state.time, endAt: state.time, clearSince: null, motion: undefined, waitedForTraffic: false, resolve };
    });
  }

  private record(command: Command, status: Event["status"], detail: string, waitedForTraffic?: boolean): Event {
    const event = { seq: ++this.sequence, command, status, detail, waitedForTraffic };
    this.state.events = [...this.state.events.slice(-23), event];
    return event;
  }

  private finish(detail: string, blocked = false) {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.state.action = null;
    this.state.throttle = 0;
    if (active.input.command === "brake" && !blocked) this.brakeHeld = true;
    this.state.braking = this.brakeHeld;
    this.state.yielding = false;
    const event = this.record(active.input.command, blocked ? "blocked" : "done", detail, active.waitedForTraffic);
    active.resolve(blocked ? { ok: false, error: detail, state: this.snapshot() } : { ok: true, event, state: this.snapshot() });
  }

  tick(dt: number) {
    const state = this.state;
    state.time += dt;
    if (!this.lesson) state.traffic = trafficAt(state.time);
    const active = this.active;
    const command = active?.input.command;
    const amount = active?.input.amount;
    const motion = active?.motion;
    if (active && (state.phase === "entering" || state.phase === "exiting")) {
      const entering = state.phase === "entering";
      state.phaseProgress = clamp((state.time - active.started) / (active.endAt - active.started), 0, 1);
      state.door = doorAngle(state.phase, state.phaseProgress);
      if (state.phaseProgress === 1) {
        state.phase = entering ? "driving" : "outside";
        state.phaseProgress = 0;
        state.door = 0;
        this.finish(entering ? "Driver seated. Door latched." : "Remy is outside. Door latched.");
      }
      return;
    }
    if (state.phase !== "driving") return;
    if (this.lesson && command && (lessonCommands as readonly Command[]).includes(command)) {
      const done = this.lesson.tick(dt, state);
      if (done) this.finish(done);
      return;
    }

    const turn = command === "turn_left" ? 1 : command === "turn_right" ? -1 : 0;
    const targetSteering = motion ? turn * BOUNDED_STEERING : turn * (amount ?? 0.6) * 0.58;
    state.steering += (targetSteering - state.steering) * (1 - Math.exp(-10 * dt));
    state.throttle = command === "gas" ? amount ?? 1 : active?.input.throttle ?? 0;
    state.yielding = command === "yield";
    state.braking = this.brakeHeld || state.yielding || command === "brake";

    const acceleration = state.braking ? -BRAKING : state.throttle > 0 ? GAS_ACCELERATION * state.throttle : turn ? -0.65 : -1.2;
    let nextSpeed = clamp(state.speed + acceleration * dt, 0, MAX_SPEED);
    let distance = (state.speed + nextSpeed) * dt / 2;
    if (active && motion) {
      if (motion.waitingToDepart && state.z <= COURSE.yieldLineZ) {
        if (!trafficClearForCrossing(state.traffic)) {
          active.waitedForTraffic = true;
          state.throttle = 0;
          state.braking = true;
          return;
        }
      }
      motion.waitingToDepart = false;
      const gap = stopLineGap(state.z) - COURSE.lineMarginMeters;
      const forward = Math.cos(state.heading);
      const available = !motion.crossing && state.z < COURSE.clearZ && forward > 0
        ? Math.min(motion.remaining, Math.max(0, gap) / forward)
        : motion.remaining;
      const targetSpeed = Math.min(turn ? 3 : 5, Math.sqrt(2 * BRAKING * available));
      nextSpeed = state.speed + clamp(targetSpeed - state.speed, -BRAKING * dt, GAS_ACCELERATION * dt);
      distance = Math.min(available, (state.speed + nextSpeed) * dt / 2);
      motion.remaining -= distance;
      if (available - distance <= EPSILON) nextSpeed = 0;
      state.braking = nextSpeed < state.speed;
      state.throttle = nextSpeed > state.speed ? 1 : 0;
    }
    const curvature = motion?.curvature ?? Math.tan(state.steering) / DRIVER.wheelbase;
    const nextHeading = state.heading + distance * curvature;
    const x = state.x + Math.sin((state.heading + nextHeading) / 2) * distance;
    const z = state.z + Math.cos((state.heading + nextHeading) / 2) * distance;
    const northSouthRoad = Math.abs(x) <= COURSE.halfRoad && z >= COURSE.south && z <= COURSE.north;
    const crossRoad = Math.abs(z - COURSE.crossingZ) <= COURSE.crossingHalfWidth && x >= COURSE.west && x <= COURSE.east;
    const traffic = state.traffic;
    const hitsTraffic = traffic.visible && Math.abs(x - traffic.x) < DRIVER.halfWidth + DRIVER.halfLength
      && Math.abs(z - traffic.z) < DRIVER.halfLength + DRIVER.halfWidth;
    if (distance > 0 && (!northSouthRoad && !crossRoad || hitsTraffic)) {
      state.speed = 0;
      if (motion || !state.braking) this.finish(hitsTraffic ? "Stopped at crossing traffic. Yield for a gap." : "Stopped at the edge of the course.", true);
    } else {
      state.x = x;
      state.z = z;
      state.heading = nextHeading;
      state.speed = nextSpeed;
      state.wheelRoll += distance / DRIVER.wheelRadius;
    }
    if (state.z >= COURSE.clearZ) state.clearedToCross = false;
    if (!active || this.active !== active) return;
    if (motion) {
      if (nextSpeed === 0) {
        const detail = motion.remaining > EPSILON ? "Stopped before the yield line. Yield before crossing."
          : turn ? (turn > 0 ? "Steered left and stopped." : "Steered right and stopped.")
          : motion.crossing ? "Cleared the intersection and parked."
          : "Reached the target and stopped.";
        this.finish(detail);
      }
    } else if (command === "yield") {
      active.waitedForTraffic ||= traffic.occupied;
      if (!traffic.occupied && state.speed === 0) active.clearSince ??= state.time;
      else active.clearSince = null;
      if (active.clearSince !== null && state.time - active.clearSince >= 1.25) {
        const gap = stopLineGap(state.z);
        state.clearedToCross = gap >= 0 && gap <= COURSE.yieldApproachMeters;
        this.finish(state.clearedToCross ? "Yield complete. Ready to cross when traffic permits."
          : "Car stopped. Approach the yield line before requesting clearance.");
      }
    } else if (command === "brake") {
      if (state.speed === 0) this.finish("Car stopped.");
    } else if (state.time >= active.endAt) {
      this.finish(turn ? (turn > 0 ? "Steered left." : "Steered right.") : "Gas released.");
    }
  }
}
