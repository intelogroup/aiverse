import { z } from "zod";

export const lessonIds = ["lane_change", "lane_change_right", "three_point", "right_turn", "left_turn", "no_turn_on_red", "crosswalk"] as const;
export type LessonId = (typeof lessonIds)[number];
export const directions = ["left", "right"] as const;
export type Direction = (typeof directions)[number];
export const cameraViews = ["ahead", "road", "signal_detail", ...directions, "right_detail"] as const;
export type CameraView = (typeof cameraViews)[number];
export const headlightModes = ["off", "low", "high"] as const;
export type HeadlightMode = (typeof headlightModes)[number];
export const checks = ["mirrors_and_blind_spot", "both_directions", "rear_and_both_directions", "intersection"] as const;
export type Check = (typeof checks)[number];
export const lessonCommands = ["check", "signal", "wait", "change_lane", "three_point", "intersection_turn", "approach_lesson"] as const;
export const commands = ["enter", "exit", "gas", "turn_left", "turn_right", "brake", "yield", "headlights", ...lessonCommands] as const;
export type Command = (typeof commands)[number];

export const movingInput = {
  seconds: z.number().min(0.2).max(4).optional().describe("Seconds to hold the input, 0.2–4. Defaults to one second."),
  amount: z.number().min(0.15).max(1).optional().describe("Input strength, 0.15–1. Defaults to 1 for gas and 0.6 for steering."),
};

export const turnThrottle = z.number().min(0.15).max(1).optional().describe("Optional gas applied while steering. Use 0.5 for a gentle turn from a stop.");

export const driveMeters = z.number().min(0.5).max(30);
export const turnDegrees = z.number().min(2).max(30);
export const driveDestination = z.enum(["yield_line", "far_side"]);
const motionSchema = z.union([
  z.strictObject({ meters: driveMeters }),
  z.strictObject({ degrees: turnDegrees }),
  z.strictObject({ destination: driveDestination }),
]);

export const actionSchema = z.strictObject({
  command: z.enum(commands).describe("Enter or exit the driver seat, apply gas, turn left or right, brake, or stop and yield for crossing traffic."),
  ...movingInput,
  throttle: turnThrottle,
  motion: motionSchema.optional(),
  direction: z.enum(directions).optional(),
  check: z.enum(checks).optional(),
  beam: z.enum(headlightModes).optional(),
  speed: z.number().min(3).max(20).optional().describe("Cruise speed in metres per second for an approach."),
});
export type DriveAction = z.infer<typeof actionSchema>;

export const COURSE = {
  spawn: { x: 2.6, z: -24 },
  crossingZ: 8,
  trafficCycleSeconds: 14,
  yieldLineZ: 2.5,
  yieldApproachMeters: 4,
  lineMarginMeters: 0.75,
  alignmentDegrees: 3,
  clearZ: 15,
  parkZ: 19,
  crossingHalfWidth: 4,
  north: 53,
  south: -36,
  east: 29,
  west: -29,
  halfRoad: 6.1,
} as const;

export const DRIVER = {
  entrySeconds: 4.65,
  exitSeconds: 4.1,
  seat: [0.001, 0.435, 0.48],
  doorOpen: -1.16,
  wheelRadius: 0.384,
  wheelbase: 2.8,
  halfLength: 2.45,
  halfWidth: 1.05,
  steeringWheelRatio: 1.65,
} as const;

export type Phase = "outside" | "entering" | "driving" | "exiting";
export type Event = {
  seq: number;
  command: Command;
  status: "started" | "done" | "blocked";
  detail: string;
  waitedForTraffic?: boolean;
};
export type DriveState = {
  time: number;
  phase: Phase;
  phaseProgress: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  steering: number;
  wheelRoll: number;
  door: number;
  throttle: number;
  braking: boolean;
  headlights: HeadlightMode;
  yielding: boolean;
  clearedToCross: boolean;
  traffic: { x: number; z: number; visible: boolean; occupied: boolean; wheelRoll: number };
  action: Command | null;
  events: Event[];
  lesson?: import("./lessons").LessonState;
};

export function stopLineGap(z: number) {
  return COURSE.yieldLineZ - z - DRIVER.halfLength;
}

export function cameraScene(state: DriveState) {
  return JSON.stringify([
    state.lesson?.id, state.phase, state.events.at(-1)?.seq,
    state.x.toFixed(1), state.z.toFixed(1), state.heading.toFixed(2), state.lesson?.signalHead, state.lesson?.hazard,
  ]);
}

export type ActionResult =
  | { ok: true; event: Event; state: DriveState }
  | { ok: false; error: string; code?: string; recovery?: import("./driver").Recovery; state: DriveState };
