import { cameraScene, cameraViews, lessonIds, type ActionResult, type CameraView, type Command, type DriveAction, type DriveState, type HeadlightMode } from "./protocol";
import { lessons } from "./lessons";
import { createRenderer } from "./render";

function element<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
const viewport = element("viewport");
const settings = new URLSearchParams(location.search);
const cameraMode = settings.get("camera");
const followCamera = cameraMode === "follow";
const visionCamera = cameraMode === "vision";
const returnToExterior = element<HTMLButtonElement>("exterior");
const switchToCockpit = element<HTMLButtonElement>("cockpit");
const seatButton = element<HTMLButtonElement>("enter");
const demoButton = element<HTMLButtonElement>("demo");
const trace = element("trace");
const feedback = element("feedback");
const connection = element("connection");
const controls = [...document.querySelectorAll<HTMLButtonElement>("button[data-command]")];
const lessonSelect = element<HTMLSelectElement>("lesson");
const headlightSelect = element<HTMLSelectElement>("headlights");
for (const id of lessonIds) lessonSelect.add(new Option(lessons[id].title, id));

const commandNames: Record<Command, string> = {
  enter: "Enter car", exit: "Exit car", gas: "Gas", turn_left: "Turn left",
  turn_right: "Turn right", brake: "Brake", yield: "Yield",
  headlights: "Headlights", signal: "Turn signal", check: "Traffic check", wait: "Wait", approach_lesson: "Approach and stop",
  change_lane: "Change lanes", three_point: "Three-point turn", intersection_turn: "Intersection turn",
};
const demoRoute: DriveAction[] = [
  { command: "enter" },
  { command: "gas", seconds: 1.45 },
  { command: "turn_left", seconds: 0.52, amount: 0.55 },
  { command: "turn_right", seconds: 0.7, amount: 0.42 },
  { command: "gas", seconds: 1.15 },
  { command: "brake" },
  { command: "gas", seconds: 0.8 },
  { command: "yield" },
  { command: "gas", seconds: 3 },
  { command: "brake" },
];

let newer: DriveState | null = null;
let older: DriveState | null = null;
let receivedAt = 0;
let cockpit = false;
let ready = false;
let demoRunning = false;
let demoGeneration = 0;
let lastEvent = -1;
let cameraView: CameraView = "ahead";

function publishState(state: DriveState) {
  if (!followCamera && newer?.phase !== state.phase) cockpit = state.phase === "driving";
  older = newer && newer.time < state.time ? newer : state;
  newer = state;
  receivedAt = performance.now();
  updateUI(state);
}

function updateUI(state: DriveState) {
  returnToExterior.setAttribute("aria-pressed", String(!cockpit));
  switchToCockpit.setAttribute("aria-pressed", String(cockpit));
  switchToCockpit.disabled = followCamera || state.phase !== "driving";
  element("view-name").textContent = cockpit ? "Remy’s first-person view" : followCamera ? "Follow camera" : "Exterior camera";
  element("speed").textContent = Math.round(3.6 * state.speed).toString().padStart(2, "0");
  element("driver-status").textContent = { outside: "Outside car", entering: "Entering car", driving: "In driver seat", exiting: "Exiting car" }[state.phase];
  const crossing = element("crossing-status");
  lessonSelect.value = state.lesson?.id ?? "";
  headlightSelect.value = state.headlights;
  headlightSelect.disabled = !ready || state.phase !== "driving";
  crossing.textContent = state.lesson ? state.lesson.passed ? "Lesson passed" : state.lesson.benchmark ? "Road test" : lessons[state.lesson.id].title
    : state.yielding ? "Yielding" : state.traffic.occupied ? "Cross traffic" : "Crossing clear";
  crossing.dataset.attention = String(state.traffic.occupied || state.yielding || Boolean(state.lesson?.hazard));
  seatButton.dataset.command = state.phase === "driving" ? "exit" : "enter";
  seatButton.textContent = commandNames[seatButton.dataset.command as Command];
  demoButton.disabled = !ready || demoRunning || Boolean(state.lesson) || state.action !== null;
  demoButton.textContent = demoRunning ? "Demo running…" : "Run demo";
  for (const button of controls) {
    const command = button.dataset.command as Command;
    const canInterrupt = (command === "brake" || command === "yield") && ["gas", "turn_left", "turn_right"].includes(state.action ?? "")
      || command === "brake" && Boolean(state.lesson && state.phase === "driving" && state.action && state.action !== "brake");
    button.disabled = !ready || demoRunning || (state.action !== null && !canInterrupt)
      || (Boolean(state.lesson) && !["enter", "exit", "brake"].includes(command))
      || (command === "enter" ? state.phase !== "outside" : state.phase !== "driving")
      || (command === "exit" && state.speed > 0)
      || ((command === "turn_left" || command === "turn_right") && state.speed < 0.3);
  }
  const seq = state.events.at(-1)?.seq ?? 0;
  if (seq === lastEvent) return;
  lastEvent = seq;
  const entries = state.events.toReversed().map((event) => {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = commandNames[event.command];
    item.append(label, ` · ${event.detail || "Started"}`);
    return item;
  });
  if (entries.length) trace.replaceChildren(...entries);
  else trace.innerHTML = "<li>Waiting for a driver command</li>";
}

function interpolated(now: number): DriveState | null {
  if (!older || !newer) return newer;
  const fraction = Math.min(1, (now - receivedAt) / Math.max(1, (newer.time - older.time) * 1000));
  const blend = (previous: number, next: number) => previous + (next - previous) * fraction;
  return {
    ...newer,
    time: blend(older.time, newer.time),
    x: blend(older.x, newer.x), z: blend(older.z, newer.z), heading: blend(older.heading, newer.heading),
    wheelRoll: blend(older.wheelRoll, newer.wheelRoll), steering: blend(older.steering, newer.steering),
    phaseProgress: older.phase === newer.phase ? blend(older.phaseProgress, newer.phaseProgress) : newer.phaseProgress,
    door: blend(older.door, newer.door),
    traffic: older.traffic.visible && newer.traffic.visible ? {
      ...newer.traffic, x: blend(older.traffic.x, newer.traffic.x), wheelRoll: blend(older.traffic.wheelRoll, newer.traffic.wheelRoll),
    } : newer.traffic,
  };
}

async function api<T>(path: string, input?: RequestInit) {
  const response = await fetch(`/api/${path}`, input);
  if (!response.ok) throw new Error((await response.json()).error ?? `Request failed (${response.status}).`);
  return response.json() as Promise<T>;
}
async function act(action: DriveAction) {
  const result = await api<ActionResult>("action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}
function showError(error: unknown) {
  feedback.textContent = error instanceof Error ? error.message : String(error);
}
async function reset(lesson = lessonSelect.value) {
  publishState(await api<DriveState>(lesson ? `reset?lesson=${encodeURIComponent(lesson)}` : "reset", { method: "POST" }));
  cockpit = false;
}
controls.forEach((button) => button.addEventListener("click", async () => {
  const command = button.dataset.command as Command;
  const action = command === "turn_left" || command === "turn_right" ? { command, seconds: 0.48 } : { command };
  try {
    feedback.textContent = `${commandNames[command]} in progress…`;
    feedback.textContent = (await act(action)).event.detail;
  } catch (error) {
    showError(error);
  }
}));
element("reset").addEventListener("click", async () => {
  demoGeneration++;
  demoRunning = false;
  try {
    await reset();
    feedback.textContent = "Course reset.";
  } catch (error) {
    showError(error);
  }
});
lessonSelect.addEventListener("change", async () => {
  try {
    await reset();
    feedback.textContent = "Lesson ready for an agent.";
  } catch (error) {
    showError(error);
  }
});
headlightSelect.addEventListener("change", async () => {
  try {
    feedback.textContent = (await act({ command: "headlights", beam: headlightSelect.value as HeadlightMode })).event.detail;
  } catch (error) {
    showError(error);
  }
});
demoButton.addEventListener("click", async () => {
  const generation = ++demoGeneration;
  demoRunning = true;
  if (newer) updateUI(newer);
  try {
    await reset();
    for (const action of demoRoute) {
      if (generation !== demoGeneration) return;
      feedback.textContent = `${commandNames[action.command]} in progress…`;
      await act(action);
    }
    feedback.textContent = "Demo complete. Crossed the junction and stopped.";
  } catch (error) {
    if (generation === demoGeneration) showError(error);
  } finally {
    if (generation === demoGeneration) demoRunning = false;
    if (newer) updateUI(newer);
  }
});
returnToExterior.addEventListener("click", () => {
  cockpit = false;
  if (newer) updateUI(newer);
});
switchToCockpit.addEventListener("click", () => {
  cockpit = true;
  if (newer) updateUI(newer);
});

function status(live: boolean) {
  connection.dataset.live = String(live);
  connection.textContent = live ? ready ? "Simulation live" : "Loading simulation" : "Simulation disconnected";
}

async function poll() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("Simulation unavailable.");
    const view = response.headers.get("x-drive-view") as CameraView | null;
    cameraView = view && cameraViews.includes(view) ? view : "ahead";
    publishState(await response.json() as DriveState);
    status(true);
  } catch {
    status(false);
  } finally {
    setTimeout(poll, 62);
  }
}

void poll();
try {
  const view = await createRenderer(viewport, settings.get("lighting") === "night");
  element("loading").hidden = true;
  ready = true;
  if (newer) updateUI(newer);
  let prior = performance.now();
  let nextCapture = 0;
  let publishing = false;
  const image = visionCamera ? document.createElement("canvas") : undefined;
  const render = (now: number) => {
    requestAnimationFrame(render);
    if (visionCamera && now - prior < 100) return;
    const state = visionCamera ? newer : interpolated(now);
    const driverEye = visionCamera && state?.phase === "driving";
    const gaze = visionCamera ? cameraView : undefined;
    if (state) view.frame(state, driverEye || cockpit, Math.min(0.1, (now - prior) / 1000), followCamera, gaze);
    if (state && driverEye && image && !publishing && now >= nextCapture) {
      publishing = true;
      nextCapture = now + 620;
      const frameId = cameraScene(state);
      image.width = Math.min(1120, view.canvas.width);
      image.height = Math.round(image.width * view.canvas.height / view.canvas.width);
      image.getContext("2d")?.drawImage(view.canvas, 0, 0, image.width, image.height);
      image.toBlob(async (blob) => {
        try {
          if (blob) await fetch("/api/cockpit", {
            method: "POST", body: blob,
            headers: { "content-type": "image/jpeg", "x-drive-scene": frameId, "x-drive-view": gaze ?? "ahead" },
          });
        } catch {
          // The next frame can recover from a local server restart.
        } finally {
          publishing = false;
        }
      }, "image/jpeg", 0.82);
    }
    prior = now;
  };
  requestAnimationFrame(render);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  element("loading").textContent = `Unable to render the driving lab. ${message}`;
}
