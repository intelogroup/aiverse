// Async photographs behind POST /world/see.
//
// A capture takes tens of seconds to minutes (CPU host) and the look service renders one frame at a time, so the route never
// holds an agent's call open for it: POST /world/see queues a job and answers 202 at once, GET /world/see/:id reports it. The
// agent keeps acting while the photo renders.
//
// Freshness is the hard part, so every job carries what the agent needs to judge it:
//   - the pose and time it was REQUESTED at (the photo shows the world as of then, not as of delivery);
//   - a queue-wait cap: a job that sat longer than maxQueueWaitMs is dropped without rendering (a late photo of a stale pose is
//     worse than none; the agent re-requests from where it stands now);
//   - when the render finishes, how far the body has moved and turned since the request (`moved`), read from the sim.
// One job per agent in flight, a bounded queue, a fixed render concurrency. State is in memory: the gateway is a single instance
// (advisory lock); a second instance would answer 404 unknown_see for jobs it does not hold.
import { randomUUID } from "node:crypto";
import type { LookClient, LookFrame } from "./lookClient";

export type SeeState = "queued" | "running" | "done" | "failed";
export type SeeFailure = "look_unavailable" | "timeout" | "stale_dropped" | "cancelled";

export interface SeePose { x: number; z: number; headingDeg: number }
export interface SeeMoved { distanceM: number; turnedDeg: number }

export interface SeeJob {
  id: string;
  agentId: string;
  state: SeeState;
  requestedAt: number;
  startedAt?: number;
  completedAt?: number;
  pose: SeePose;
  frame?: LookFrame & { latencyMs: number };
  error?: SeeFailure;
  moved?: SeeMoved;
}

export interface SeeQueueOptions {
  /** Captures in flight at once (the look service serializes on one page: 1 unless more instances sit behind it). */
  concurrency: number;
  /** Jobs allowed to wait. Past this a submit is refused as busy. */
  maxQueue: number;
  /** A queued job older than this when its turn comes is dropped, not rendered. */
  maxQueueWaitMs: number;
  /** Finished jobs stay readable this long, and at most maxKept of them. */
  keepMs: number;
  maxKept: number;
  now?: () => number;
}

export interface SeeHooks {
  /** After a successful capture, before the job is marked done: where is the body now? Used for `moved`. Never throws. */
  moved?: (job: SeeJob) => Promise<SeeMoved | undefined>;
  /** A job ended without a photo (failed or dropped): give back what the request cost. Never throws. */
  refund?: (job: SeeJob) => Promise<void>;
}

export type SubmitResult =
  | { ok: true; job: SeeJob }
  | { ok: false; reason: "in_flight"; job: SeeJob }
  | { ok: false; reason: "busy" };

export function angleDiffDeg(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

export function createSeeQueue(look: LookClient, opts: SeeQueueOptions) {
  const now = opts.now ?? Date.now;
  const jobs = new Map<string, SeeJob>();
  const active = new Map<string, string>(); // agentId -> job id while queued or running
  const waiters = new Map<string, (() => void)[]>();
  const hooks = new Map<string, SeeHooks>();
  const queue: string[] = [];
  let running = 0;

  const wake = (id: string) => { for (const w of waiters.get(id) ?? []) w(); waiters.delete(id); };

  function prune() {
    const t = now();
    for (const [id, j] of jobs) if (j.completedAt && t - j.completedAt > opts.keepMs) { jobs.delete(id); hooks.delete(id); }
    if (jobs.size <= opts.maxKept) return;
    for (const [id, j] of jobs) { if (jobs.size <= opts.maxKept) break; if (j.completedAt) { jobs.delete(id); hooks.delete(id); } }
  }

  async function finish(job: SeeJob, state: "done" | "failed", error?: SeeFailure) {
    job.completedAt = now();
    if (state === "failed") { job.error = error; await hooks.get(job.id)?.refund?.(job).catch(() => {}); }
    job.state = state;
    active.delete(job.agentId);
    wake(job.id);
  }

  async function run(job: SeeJob) {
    job.state = "running";
    job.startedAt = now();
    let out: Awaited<ReturnType<LookClient["look"]>>;
    try {
      out = await look.look(job.agentId, [job.pose.x, job.pose.z], job.pose.headingDeg);
    } catch {
      out = { ok: false, reason: "unavailable" };
    }
    if (!out.ok) return finish(job, "failed", out.reason === "timeout" ? "timeout" : "look_unavailable");
    job.frame = { ...out.frame, latencyMs: out.serviceMs };
    job.moved = await hooks.get(job.id)?.moved?.(job).catch(() => undefined);
    return finish(job, "done");
  }

  function pump() {
    while (running < opts.concurrency && queue.length) {
      const id = queue.shift()!;
      const job = jobs.get(id);
      if (!job || job.state !== "queued") continue;
      if (now() - job.requestedAt > opts.maxQueueWaitMs) { void finish(job, "failed", "stale_dropped"); continue; }
      running++;
      void run(job).finally(() => { running--; pump(); });
    }
  }

  return {
    submit(agentId: string, pose: SeePose, h: SeeHooks = {}): SubmitResult {
      const cur = active.get(agentId);
      if (cur) return { ok: false, reason: "in_flight", job: jobs.get(cur)! };
      if (queue.length >= opts.maxQueue) return { ok: false, reason: "busy" };
      prune();
      const job: SeeJob = { id: randomUUID(), agentId, state: "queued", requestedAt: now(), pose };
      jobs.set(job.id, job);
      hooks.set(job.id, h);
      active.set(agentId, job.id);
      queue.push(job.id);
      pump();
      return { ok: true, job };
    },
    /** The agent's queued or running job, if any. */
    activeFor(agentId: string): SeeJob | undefined {
      const id = active.get(agentId);
      return id ? jobs.get(id) : undefined;
    },
    /** The agent's own job only: another agent's id answers undefined, same as an unknown one. */
    get(agentId: string, id: string): SeeJob | undefined {
      const j = jobs.get(id);
      return j && j.agentId === agentId ? j : undefined;
    },
    /** Resolves when the job leaves queued/running, or after ms. */
    wait(job: SeeJob, ms: number): Promise<void> {
      if (job.state === "done" || job.state === "failed" || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        const list = waiters.get(job.id) ?? [];
        list.push(() => { clearTimeout(t); resolve(); });
        waiters.set(job.id, list);
      });
    },
    /** For tests and the route's drop-on-agent-gone path. */
    cancelAgent(agentId: string) {
      const id = active.get(agentId);
      const j = id ? jobs.get(id) : undefined;
      if (j && j.state === "queued") void finish(j, "failed", "cancelled");
    },
    stats: () => ({ queued: queue.length, running, kept: jobs.size }),
  };
}

/** What an agent reads: the job without its owner, plus how old the request is right now. */
export function seeView(job: SeeJob, nowMs: number) {
  const { agentId: _agentId, frame, ...rest } = job;
  return {
    ...rest,
    ageMs: nowMs - job.requestedAt,
    ...(frame ? { photoPng: frame.photoPng, width: frame.width, height: frame.height, depthSummary: frame.depthSummary, cameraPose: frame.pose, renderMs: frame.renderMs, latencyMs: frame.latencyMs, pitchSupported: frame.pitchSupported, capturedAt: frame.capturedAt } : {}),
  };
}
