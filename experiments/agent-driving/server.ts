import page from "./index.html";
import { actionSchema, cameraScene, cameraViews, COURSE, lessonIds, type CameraView, type LessonId } from "./protocol";
import { DrivingSimulation } from "./simulation";
import { assessAttempt, benchmarkIds, examScore, scoreBenchmark, type Attempt, type BenchmarkId } from "./benchmark";

const simulation = new DrivingSimulation();
const STEP = 1 / 60;
let previous = performance.now();
let pending = 0;
setInterval(() => {
  const now = performance.now();
  pending += Math.min((now - previous) / 1000, 0.1);
  previous = now;
  while (pending >= STEP) {
    simulation.tick(STEP);
    pending -= STEP;
  }
}, 1000 * STEP);

function file(path: string) {
  const asset = Bun.file(new URL(path, import.meta.url));
  return async () => new Response(asset, { headers: { "cache-control": "public, max-age=3600" } });
}

const port = Number(process.env.DRIVE_LAB_PORT || 5198);
const localhost = `http://127.0.0.1:${port}`;
let cameraView: CameraView = "ahead";
let cameraFrame: { frame: ArrayBuffer; scene: string; view: CameraView; receivedAt: number } | undefined;
let attempts: Attempt[] = [];
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === null || origin === localhost || origin === `http://localhost:${port}`;
}
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function applyAction(request: Request, driver = false) {
  if (!sameOrigin(request)) return json({ error: "Open the local lab to control this car." }, 403);
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues.map((issue) => issue.message).join(". ") }, 400);
  const before = simulation.snapshot();
  const run = attempts;
  const result = await (driver ? simulation.actAsDriver(parsed.data) : simulation.act(parsed.data));
  if (before.lesson?.benchmark && run === attempts) run.push(assessAttempt(parsed.data, before, result));
  return json(result);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 30,
  routes: {
    "/": page,
    "/assets/car-concept.glb": file("./assets/car-concept.glb"),
    "/assets/sky.hdr": file("./assets/sky.hdr"),
    "/assets/remy.glb": file("../../apps/console/public/assets/cast-remy-lite.glb"),
    "/basis/basis_transcoder.js": file("../../apps/console/public/basis/basis_transcoder.js"),
    "/basis/basis_transcoder.wasm": file("../../apps/console/public/basis/basis_transcoder.wasm"),
    "/api/state": {
      GET: () => Response.json(simulation.snapshot(), { headers: { "cache-control": "no-store", "x-drive-view": cameraView } }),
    },
    "/api/action": { POST: (request) => applyAction(request) },
    "/api/driver/action": { POST: (request) => applyAction(request, true) },
    "/api/assessment": { GET: () => {
      const state = simulation.snapshot();
      return state.lesson?.benchmark
        ? json({ id: state.lesson.benchmark, ...scoreBenchmark(state, attempts), ...(state.lesson.exam && examScore(state, attempts)), attempts })
        : json({ error: "Select a benchmark scenario first." }, 409);
    } },
    "/api/cockpit": {
      GET: (request) => {
        const view = new URL(request.url).searchParams.get("view") ?? "ahead";
        if (!(cameraViews as readonly string[]).includes(view)) return json({ error: "Unknown camera view." }, 400);
        cameraView = view as CameraView;
        const state = simulation.snapshot();
        if (!cameraFrame || cameraFrame.view !== cameraView || Date.now() - cameraFrame.receivedAt > 4000 || cameraFrame.scene !== cameraScene(state)) {
          return json({ error: "No fresh cockpit frame. Open the lab with ?camera=vision and take the driver seat." }, 409);
        }
        return new Response(cameraFrame.frame, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
      },
      POST: async (request) => {
        if (!sameOrigin(request) || request.headers.get("content-type") !== "image/jpeg") return json({ error: "Expected a local JPEG frame." }, 403);
        const bytes = Number(request.headers.get("content-length"));
        if (!Number.isInteger(bytes) || bytes < 4 || bytes > 240_000) return json({ error: "Invalid frame size." }, 413);
        const scene = request.headers.get("x-drive-scene");
        const view = cameraView;
        if (scene !== cameraScene(simulation.snapshot()) || request.headers.get("x-drive-view") !== view) return json({ error: "Frame is stale." }, 409);
        const frame = await request.arrayBuffer();
        const image = new Uint8Array(frame);
        if (image.length !== bytes || image[0] !== 0xff || image[1] !== 0xd8) return json({ error: "Invalid JPEG." }, 400);
        cameraFrame = { frame, scene, view, receivedAt: Date.now() };
        return new Response(null, { status: 204 });
      },
    },
    "/api/reset": {
      POST: (request) => {
        if (!sameOrigin(request)) return json({ error: "Open the local lab to reset this car." }, 403);
        const params = new URL(request.url).searchParams;
        const offset = Number(params.get("trafficOffset") ?? 0);
        if (!Number.isFinite(offset) || offset < 0 || offset >= COURSE.trafficCycleSeconds) return json({ error: "Traffic offset must be within one cycle." }, 400);
        const lesson = params.get("lesson");
        const benchmark = params.get("benchmark") as BenchmarkId | null;
        if (lesson !== null && !(lessonIds as readonly string[]).includes(lesson)) return json({ error: "Unknown driving lesson." }, 400);
        if (benchmark && (lesson || !benchmarkIds.includes(benchmark))) return json({ error: "Choose a known benchmark without a preset lesson." }, 400);
        cameraFrame = undefined;
        cameraView = "ahead";
        attempts = [];
        simulation.reset(offset, benchmark ? "right_turn" : lesson ? lesson as LessonId : undefined, benchmark ?? undefined, params.get("mode") === "exam");
        return json(simulation.snapshot());
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
});
console.log(`Agent Driving Lab · ${server.url}`);
