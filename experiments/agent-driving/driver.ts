import { COURSE, stopLineGap, type CameraView, type Check, type Direction, type DriveAction, type DriveState } from "./protocol";
import { isIntersectionLesson, isLaneChange } from "./lessons";
import { benchmarkCase } from "./benchmark";

export type DriverTool = "drive_enter" | "drive_exit" | "drive_observe" | "drive_gas" | "drive_brake"
  | "drive_turn_left" | "drive_turn_right" | "drive_approach" | "drive_yield" | "drive_cross"
  | "drive_check" | "drive_signal" | "drive_wait" | "drive_change_lane" | "drive_three_point" | "drive_intersection_turn"
  | "drive_headlights";

export type Recovery = { tool: DriverTool | "drive_look"; arguments: { degrees?: number; area?: Check; direction?: Direction; view?: CameraView } };
const noArgs = (tool: DriverTool): Recovery => ({ tool, arguments: {} });

export function inspectDriver(state: DriveState) {
  const course = state.lesson?.benchmark ? benchmarkCase(state.lesson.benchmark) : undefined;
  const gap = stopLineGap(state.z) + (course ? course.shift + course.stopOffset : 0);
  const heading = Math.atan2(Math.sin(state.heading), Math.cos(state.heading)) * 180 / Math.PI;
  const aligned = Math.abs(heading) <= COURSE.alignmentDegrees;
  const crossingStatus = state.z >= COURSE.clearZ ? "past"
    : state.z >= COURSE.yieldLineZ ? "inside"
    : state.clearedToCross ? "yielded"
    : gap < 0 ? "past_line"
    : gap <= COURSE.yieldApproachMeters ? "at_line" : "ahead";
  const alignment: Recovery | undefined = aligned ? undefined : {
    tool: heading > 0 ? "drive_turn_right" : "drive_turn_left",
    arguments: { degrees: Math.min(30, Math.round(Math.abs(heading) * 10) / 10) },
  };

  const availableTools: DriverTool[] = ["drive_observe"];
  if (state.phase === "driving") availableTools.push("drive_headlights");
  let next: Recovery | undefined;
  if (state.lesson) {
    if (state.phase === "outside") availableTools.push("drive_enter");
    if (state.phase === "driving") {
      availableTools.push("drive_brake");
      if (!state.action && state.speed === 0) {
        availableTools.push("drive_exit");
        if (!state.lesson.passed) {
          availableTools.push("drive_check", "drive_signal", "drive_wait");
          if (isIntersectionLesson(state.lesson.id)) {
            if (course?.chapter === "route" && !state.lesson.laneChanged) availableTools.push("drive_change_lane");
            availableTools.push("drive_approach", "drive_intersection_turn");
          }
          else availableTools.push(isLaneChange(state.lesson.id) ? "drive_change_lane" : "drive_three_point");
        }
      }
    }
    return { gap, heading, aligned, crossingStatus, availableTools, next };
  }
  if (state.phase === "outside") {
    availableTools.push("drive_enter");
  } else if (state.phase === "driving") {
    if (state.action !== "yield" && state.action !== "brake") availableTools.push("drive_brake");
    if (!state.action) {
      availableTools.push("drive_turn_left", "drive_turn_right");
      if (state.speed === 0) availableTools.push("drive_exit");
      if (crossingStatus === "ahead" || crossingStatus === "past") availableTools.push("drive_gas");
      if (crossingStatus === "ahead" && aligned) availableTools.push("drive_approach");
      if (crossingStatus === "at_line" && state.speed === 0) availableTools.push("drive_yield");
      if (state.clearedToCross && aligned && state.speed === 0) availableTools.push("drive_cross");

      if (crossingStatus === "ahead") next = alignment ?? noArgs("drive_approach");
      else if (crossingStatus === "at_line") next = noArgs(state.speed === 0 ? "drive_yield" : "drive_brake");
      else if (state.clearedToCross) next = state.speed === 0 ? alignment ?? noArgs("drive_cross") : noArgs("drive_brake");
    }
  }
  return { gap, heading, aligned, crossingStatus, availableTools, next };
}

function toolForAction(action: DriveAction): DriverTool {
  if (action.command === "gas" && action.motion && "destination" in action.motion) {
    return action.motion.destination === "yield_line" ? "drive_approach" : "drive_cross";
  }
  if (action.command === "approach_lesson") return "drive_approach";
  return `drive_${action.command}`;
}

export function driverRefusal(action: DriveAction, state: DriveState) {
  const tool = toolForAction(action);
  const view = inspectDriver(state);
  const refuse = (code: string, message: string, recovery?: Recovery) => ({ code, message, recovery });
  if (view.availableTools.includes(tool)) {
    if (["gas", "turn_left", "turn_right"].includes(action.command) && !action.motion) {
      return refuse("bounded_motion_required", "Use a distance, angle, or destination with driving tools.");
    }
    return;
  }
  if (state.phase === "outside") return refuse("driver_not_seated", "Take the driver seat first.", noArgs("drive_enter"));
  if (state.action) return refuse("maneuver_in_progress", "A maneuver is still in progress. Check the current state.", noArgs("drive_observe"));
  if (tool === "drive_enter") return refuse("already_seated", "The driver is already seated.", noArgs("drive_observe"));
  if (tool === "drive_exit") return refuse("vehicle_moving", "Come to a full stop before exiting.", noArgs("drive_brake"));
  if ((tool === "drive_yield" || tool === "drive_cross") && view.next?.tool === "drive_brake") {
    return refuse("vehicle_moving", "Stop before yielding or starting to cross.", view.next);
  }
  if (tool === "drive_yield" && view.crossingStatus === "ahead") {
    return refuse("before_yield_line", "Yield was refused. The front bumper has not reached the yield zone.", view.next);
  }
  if ((tool === "drive_approach" || tool === "drive_cross") && !view.aligned && view.next?.tool.startsWith("drive_turn_")) {
    return refuse("heading_misaligned", "Straighten the car before driving to the landmark.", view.next);
  }
  if (tool === "drive_cross" && !state.clearedToCross && view.next) {
    return refuse("yield_required", "Yield at the line to obtain crossing clearance.", view.next);
  }
  return refuse("maneuver_unavailable", "Choose an available maneuver for the current state.", view.next ?? noArgs("drive_observe"));
}
