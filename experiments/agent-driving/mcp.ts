import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inspectDriver } from "./driver";
import { verifyVerseAgent } from "./agent-auth";
import { cameraViews, checks, directions, driveMeters, headlightModes, turnDegrees, type ActionResult, type DriveAction, type DriveState } from "./protocol";

const server = new McpServer({ name: "aiverse-driving-lab", version: "0.2.0" });
const lab = `http://127.0.0.1:${process.env.DRIVE_LAB_PORT || 5198}`;
const simulationMutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const round = (value: number) => Math.round(value * 100) / 100;
const skill = await Bun.file(new URL("./skills/drive-car/SKILL.md", import.meta.url)).text();
const visionOnly = process.env.DRIVE_VISION_ONLY === "1";
const verifyDrivingAgent = () => verifyVerseAgent(process.env.DRIVE_REQUIRE_OWNER_OAUTH === "1");
await verifyDrivingAgent();

function observe(state: DriveState, identity: Awaited<ReturnType<typeof verifyVerseAgent>>) {
  const view = inspectDriver(state);
  const lesson = state.lesson;
  return {
    ...(identity && { agent: identity }),
    phase: state.phase,
    activeCommand: state.action,
    position: { x: round(state.x), z: round(state.z) },
    headingDegrees: round(view.heading),
    speedMps: round(state.speed),
    headlights: state.headlights,
    brakeLights: state.braking,
    availableTools: view.availableTools,
    ...(lesson ? { lesson: {
      ...(visionOnly ? {
        instructions: "Read the traffic light, signs, lane markings and actors from drive_look. Use driving checks for traffic outside the forward camera.",
        checked: lesson.checked, indicator: lesson.indicator, legs: lesson.legs, gear: lesson.gear,
        stoppedAtLine: lesson.stoppedAtLine, laneChanged: lesson.laneChanged, passed: lesson.passed,
        ...(lesson.checked && lesson.hazard && !["red_light", "pedestrian"].includes(lesson.hazard) && { detectedConflict: lesson.hazard }),
      } : lesson),
      frontBumperToLineM: round(view.gap),
    } } : { crossing: {
      status: view.crossingStatus,
      next: view.next,
      frontBumperToLineM: round(view.gap),
      trafficOnCrossing: state.traffic.occupied,
    } }),
  };
}

const asText = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
server.registerTool("drive_observe", {
  description: "Read the car pose, crossing status and currently available driving tools.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const identity = await verifyDrivingAgent();
  const state = await fetch(`${lab}/api/state`).then((res) => res.json() as Promise<DriveState>);
  return { content: asText(observe(state, identity)) };
});

server.registerPrompt("drive-car", {
  description: "Learn the controls for entering, driving, yielding, parking, and exiting a car in AIVerse.",
}, () => ({ messages: [{ role: "user", content: { type: "text", text: skill } }] }));

server.registerTool("drive_skill", {
  description: "Read the driving skill before operating the car. Explains how to steer, approach, yield and cross.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => ({ content: [{ type: "text", text: skill }] }));

server.registerTool("drive_look", {
  description: "See a live driver-eye image. Read signs and signals ahead, lane arrows from the road view, or traffic and pedestrians from a side glance.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: z.strictObject({ view: z.enum(cameraViews).optional().describe("ahead for context, road for lane arrows, signal_detail for a distant light, left or right for the junction sides, right_detail to resolve a pedestrian's feet relative to the right crosswalk. Defaults to ahead.") }),
}, async ({ view = "ahead" }) => {
  await verifyDrivingAgent();
  // The browser learns a new view from its next state poll and publishes a frame about every 620 ms; with several labs
  // rendering at once that took more than the old 5 s. Wait 15 s, then tell the agent a retry is safe.
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${lab}/api/cockpit?view=${view}`);
    if (response.ok) {
      const data = Buffer.from(await response.arrayBuffer()).toString("base64");
      return { content: [{ type: "image" as const, mimeType: "image/jpeg", data }] };
    }
    await Bun.sleep(250);
  }
  return { isError: true, content: asText({ error: "No fresh driver-eye frame yet. Call drive_look again; if it repeats, the driver must be seated (drive_enter) with the vision camera open." }) };
});

async function act(action: DriveAction) {
  const identity = await verifyDrivingAgent();
  const response = await fetch(`${lab}/api/driver/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) return { isError: true, content: asText({ error: `Driving lab returned HTTP ${response.status}.` }) };
  const result = await response.json() as ActionResult;
  return {
    isError: !result.ok,
    content: asText({
      ok: result.ok,
      message: result.ok
        ? visionOnly && result.state.lesson?.benchmark && action.command === "wait"
          ? "Wait complete. Inspect the intersection again."
          : result.event.detail
        : result.error,
      ...(!result.ok && { code: result.code, recovery: result.recovery }),
      ...(result.ok && result.event.waitedForTraffic && { waitedForTraffic: true }),
      ...observe(result.state, identity),
    }),
  };
}

const fixedCommands = {
  enter: "Open the driver's door and take the driver's seat. Waits for the entry animation to finish.",
  brake: "Apply the brake until speed is zero, then hold the pedal until you drive again. The rear stop lights stay lit while the brake is held.",
  yield: "Wait at the yield line for clear traffic. Requires crossing status at_line. If ahead, use drive_approach.",
  exit: "Exit through the driver's door while stationary.",
} as const;
for (const command of ["enter", "brake", "yield", "exit"] as const) {
  server.registerTool(`drive_${command}`, { description: fixedCommands[command], annotations: simulationMutation, inputSchema: z.strictObject({}) },
    () => act({ command }));
}

function numericInput(range: z.ZodNumber) {
  return z.union([range, z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => range.safeParse(Number(value)).success)]);
}

server.registerTool("drive_gas", {
  description: "Move straight ahead a specified number of meters and stop. Defaults to 3 meters.",
  annotations: simulationMutation,
  inputSchema: z.strictObject({ meters: numericInput(driveMeters).optional().describe("Distance in meters, 0.5–30.") }),
}, ({ meters }) => act({ command: "gas", motion: { meters: Number(meters ?? 3) } }));

server.registerTool("drive_approach", {
  description: "Approach an intersection and stop fully before the stop or yield line. Face forward first.",
  annotations: simulationMutation,
  inputSchema: z.strictObject({}),
}, () => act({ command: "gas", motion: { destination: "yield_line" } }));

server.registerTool("drive_headlights", {
  description: "Switch the front lamps between off, low beam, and high beam. Low and high also keep the red tail lamps on. Braking brightens the rear stop lamps independently.",
  annotations: simulationMutation,
  inputSchema: z.strictObject({ beam: z.enum(headlightModes) }),
}, ({ beam }) => act({ command: "headlights", beam }));

server.registerTool("drive_check", {
  description: "Check the selected view for conflicting traffic. Rear includes looking over the right shoulder before backing.",
  annotations: simulationMutation,
  inputSchema: z.strictObject({
    area: z.enum(checks).describe("Use mirrors_and_blind_spot for a lane change, both_directions for a forward turnaround leg, or rear_and_both_directions for backing. Use intersection at a junction to include mirrors, the turn-side blind spot, and the departure lane."),
  }),
}, ({ area }) => act({ command: "check", check: area }));

for (const [command, description] of [
  ["signal", "Set the turn signal before moving in that direction. For a lane change, keep it on toward the target lane; an indicator already lit stays valid after the target-side blind-spot check."],
  ["change_lane", "Change into the adjacent same-direction lane when the markings, checks, and gap permit, then center and stop."],
  ["intersection_turn", "Follow through in the chosen direction and stop in the proper departure lane. Obeys the stop, signal, and right-of-way rules."],
] as const) {
  server.registerTool(`drive_${command}`, {
    description, annotations: simulationMutation, inputSchema: z.strictObject({ direction: z.enum(directions) }),
  }, ({ direction }) => act({ command, direction }));
}

for (const [command, description] of [
  ["wait", "Hold the brake at the current position until the observed traffic conflict or signal changes. Check again afterward."],
  ["three_point", "Move through one leg of a three-point turn and stop. Legs completed 0 or 2 precede forward motion. One leg completed precedes reverse. Each new leg needs its own traffic check."],
] as const) {
  server.registerTool(`drive_${command}`, {
    description, annotations: simulationMutation, inputSchema: z.strictObject({}),
  }, () => act({ command }));
}

server.registerTool("drive_cross", {
  description: "After drive_yield confirms you yielded at the line, drive across during a safe gap and park beyond the intersection.",
  annotations: simulationMutation,
  inputSchema: z.strictObject({}),
}, () => act({ command: "gas", motion: { destination: "far_side" } }));

for (const direction of ["left", "right"] as const) {
  server.registerTool(`drive_turn_${direction}`, {
    description: `Roll through a ${direction} turn and stop. Left increases heading, right decreases it.`,
    annotations: simulationMutation,
    inputSchema: z.strictObject({
      degrees: numericInput(turnDegrees).optional().describe("Degrees to turn from the current heading, 2–30. Defaults to 10."),
    }),
  }, ({ degrees }) => act({ command: `turn_${direction}`, motion: { degrees: Number(degrees ?? 10) } }));
}

await server.connect(new StdioServerTransport());
