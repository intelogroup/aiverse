import type { ActionResult, DriveAction, DriveState } from "./protocol";

const layouts = {
  oak: { shift: -1, stopOffset: -0.25, signX: -5.75, signZ: 4.55, signalX: 0, crosswalkX: -8.45, pedestrianZ: 6.55 },
  maple: { shift: 2, stopOffset: 0.2, signX: -5.45, signZ: 5.4, signalX: 0.75, crosswalkX: -9.5, pedestrianZ: 6.9 },
  pine: { shift: 5, stopOffset: -0.45, signX: -4.95, signZ: 6.1, signalX: -0.55, crosswalkX: -10.35, pedestrianZ: 6.25 },
} as const;

type Case = {
  chapter: "decision" | "route" | "night";
  layout: keyof typeof layouts;
  signal: "red" | "green";
  posted?: boolean;
  pedestrian?: boolean;
  oncoming?: boolean;
  preselectedHigh?: boolean;
};

const cases = {
  B01: { chapter: "decision", layout: "oak", signal: "green" },
  B02: { chapter: "decision", layout: "maple", signal: "red", posted: true },
  B03: { chapter: "decision", layout: "pine", signal: "red" },
  B04: { chapter: "decision", layout: "maple", signal: "green", pedestrian: true },
  B05: { chapter: "decision", layout: "oak", signal: "red", pedestrian: true },
  B06: { chapter: "decision", layout: "pine", signal: "red", posted: true, pedestrian: true },
  B07: { chapter: "route", layout: "pine", signal: "green" },
  B08: { chapter: "route", layout: "oak", signal: "red", posted: true },
  B09: { chapter: "route", layout: "maple", signal: "green", pedestrian: true },
  B10: { chapter: "night", layout: "oak", signal: "green", oncoming: true, preselectedHigh: true },
  B11: { chapter: "night", layout: "maple", signal: "red", posted: true, pedestrian: true },
  B12: { chapter: "night", layout: "pine", signal: "green", pedestrian: true, oncoming: true },
} satisfies Record<string, Case>;

export type BenchmarkId = keyof typeof cases;
export const benchmarkIds = Object.keys(cases) as BenchmarkId[];

export function benchmarkCase(id: BenchmarkId): Case & typeof layouts[keyof typeof layouts] {
  const variant = cases[id];
  return { ...variant, ...layouts[variant.layout] };
}

export type Attempt = {
  command: DriveAction["command"];
  accepted: boolean;
  code?: string;
  unsafe: boolean;
  unnecessaryWait: boolean;
};

const unsafeCodes = new Set([
  "blind_spot_occupied", "check_target_lane", "stop_before_line", "posted_no_turn_on_red",
  "crosswalk_occupied", "yield_to_oncoming", "check_intersection", "curb_contact",
  "wrong_turn_lane", "headlights_required", "high_beam_conflict", "signal_required", "signal_before_approach", "signal_too_late",
]);

export function assessAttempt(action: DriveAction, before: DriveState, result: ActionResult): Attempt {
  const code = result.ok ? undefined : result.code;
  const movement = ["approach_lesson", "change_lane", "intersection_turn", "gas", "three_point"].includes(action.command);
  return {
    command: action.command,
    accepted: result.ok,
    code,
    unsafe: Boolean(code && unsafeCodes.has(code) && (movement || code === "high_beam_conflict")),
    unnecessaryWait: action.command === "wait" && before.lesson?.stoppedAtLine === true && !before.lesson.hazard && !before.lesson.oncoming,
  };
}

export function scoreBenchmark(state: DriveState, attempts: readonly Attempt[]) {
  const violations = attempts.filter((attempt) => attempt.unsafe);
  return {
    completed: state.lesson?.passed === true && state.speed === 0,
    firstDecisionSafe: violations.length === 0,
    unsafeRequests: violations.map((attempt) => attempt.code),
    rejectedCalls: attempts.filter((attempt) => !attempt.accepted).length,
    unnecessaryWaits: attempts.filter((attempt) => attempt.unnecessaryWait).length,
    evidence: state.lesson?.evidence ?? [],
  };
}
// Classifies a harness event stream that ended without driving, so a dead harness is never scored as a driver failure.
// Understands Codex (`error`/`turn.failed`) and Claude Code stream-json (`result` with is_error) events.
export function harnessFailure(lines: readonly string[]): "usage_limit" | "auth" | "turn_failed" | null {
  for (const line of lines) {
    let event: { type?: string; message?: string; is_error?: boolean; result?: unknown; error?: { message?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    const claudeFailure = event.type === "result" && event.is_error === true;
    if (event.type !== "turn.failed" && event.type !== "error" && !claudeFailure) continue;
    const message = String(event.error?.message ?? event.message ?? (claudeFailure ? event.result : "") ?? "").toLowerCase();
    if (/usage limit|rate limit|quota|credit balance|credits|overloaded/.test(message)) return "usage_limit";
    if (/unauthori[sz]ed|not logged in|invalid api key|authentication|login|401/.test(message)) return "auth";
    if (event.type === "turn.failed" || claudeFailure) return "turn_failed";
  }
  return null;
}

// Exam scoring: driving score = completion x 1 / (1 + sum(coefficient x count)), the CARLA leaderboard shape.
// Coefficients for collisions/red light/stop sign follow the leaderboard (read from secondary sources, verify against
// leaderboard.carla.org/evaluation_v2_1); every other value is this lab's own choice. Each rule cites the RMV manual
// in rmv/drivers-manual.txt: yield to pedestrians l.3667; turns on red l.4324-4333; lane change steps l.4135-4143.
export const INFRACTIONS: Record<string, { severity: "critical" | "minor"; coefficient: number }> = {
  crosswalk_occupied: { severity: "critical", coefficient: 1.0 },
  blind_spot_occupied: { severity: "critical", coefficient: 0.7 },
  yield_to_oncoming: { severity: "critical", coefficient: 0.7 },
  posted_no_turn_on_red: { severity: "critical", coefficient: 0.4 },
  ran_red_light: { severity: "critical", coefficient: 0.4 },
  stop_before_line: { severity: "minor", coefficient: 0.25 },
  wrong_turn_lane: { severity: "minor", coefficient: 0.25 },
  signal_too_late: { severity: "minor", coefficient: 0.1 },
  signal_required: { severity: "minor", coefficient: 0.1 },
  signal_before_approach: { severity: "minor", coefficient: 0.1 },
  check_target_lane: { severity: "minor", coefficient: 0.1 },
  check_intersection: { severity: "minor", coefficient: 0.1 },
  check_each_leg: { severity: "minor", coefficient: 0.1 },
  headlights_required: { severity: "minor", coefficient: 0.1 },
  high_beam_conflict: { severity: "minor", coefficient: 0.1 },
};
const UNNECESSARY_WAIT = 0.05;

export function examScore(state: DriveState, attempts: readonly Attempt[] = []) {
  const infractions = (state.lesson?.infractions ?? []).map(({ code }) => ({ code, ...(INFRACTIONS[code] ?? { severity: "minor" as const, coefficient: 0.1 }) }));
  const waits = attempts.filter((attempt) => attempt.unnecessaryWait).length;
  const penalty = infractions.reduce((sum, item) => sum + item.coefficient, 0) + waits * UNNECESSARY_WAIT;
  const completed = state.lesson?.passed === true && state.speed === 0;
  const critical = infractions.filter((item) => item.severity === "critical").map((item) => item.code);
  return {
    exam: { completed, infractions, critical, unnecessaryWaits: waits, score: completed ? Math.round(1000 / (1 + penalty)) / 1000 : 0, passed: completed && critical.length === 0 },
  };
}
