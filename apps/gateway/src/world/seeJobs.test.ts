import { describe, expect, test } from "bun:test";
import type { LookClient, LookOutcome } from "./lookClient";
import { angleDiffDeg, createSeeQueue, seeView, type SeeJob } from "./seeJobs";

// The queue behind POST /world/see, with a controllable look client and clock. No DB, no sim.
function harness(opts: Partial<Parameters<typeof createSeeQueue>[1]> = {}) {
  let t = 1_000_000;
  const gates: (() => void)[] = [];
  const calls: string[] = [];
  let result: LookOutcome = { ok: true, serviceMs: 10, frame: { photoPng: "p", width: 512, height: 288, depthSummary: null, pose: null, renderMs: 1, poseMs: 1, pitchSupported: false, capturedAt: null } };
  const look: LookClient = { look: (agentId) => new Promise((resolve) => { calls.push(agentId); gates.push(() => resolve(result)); }) };
  const q = createSeeQueue(look, { concurrency: 1, maxQueue: 3, maxQueueWaitMs: 30_000, keepMs: 600_000, maxKept: 10, now: () => t, ...opts });
  return { q, calls, release: () => gates.shift()?.(), advance: (ms: number) => { t += ms; }, fail: () => { result = { ok: false, reason: "unavailable" }; }, now: () => t };
}
const pose = { x: 1, z: 2, headingDeg: 90 };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("see queue", () => {
  test("one job per agent in flight: a second submit names the first", () => {
    const h = harness();
    const a = h.q.submit("a", pose);
    expect(a.ok).toBe(true);
    const again = h.q.submit("a", pose);
    expect(again.ok).toBe(false);
    if (!again.ok && again.reason === "in_flight") expect(again.job.id).toBe((a as { job: SeeJob }).job.id);
  });

  test("renders one at a time, in order; a finished agent can submit again", async () => {
    const h = harness();
    const a = h.q.submit("a", pose) as { job: SeeJob };
    const b = h.q.submit("b", pose) as { job: SeeJob };
    expect([a.job.state, b.job.state]).toEqual(["running", "queued"]);
    expect(h.calls).toEqual(["a"]);
    h.release(); await h.q.wait(a.job, 100); await flush();
    expect(a.job.state).toBe("done");
    expect(b.job.state).toBe("running");
    h.release(); await h.q.wait(b.job, 100);
    expect(h.q.submit("a", pose).ok).toBe(true);
  });

  test("a job that waited past the cap is dropped without rendering, and refunded", async () => {
    const h = harness({ maxQueueWaitMs: 5_000 });
    const refunds: string[] = [];
    const a = h.q.submit("a", pose) as { job: SeeJob };
    const b = h.q.submit("b", pose, { refund: async (j) => { refunds.push(j.agentId); } }) as { job: SeeJob };
    h.advance(6_000);
    h.release(); await h.q.wait(a.job, 100); await flush();
    expect(b.job.state).toBe("failed");
    expect(b.job.error).toBe("stale_dropped");
    expect(refunds).toEqual(["b"]);
    expect(h.calls).toEqual(["a"]); // b never reached the service
  });

  test("a failed capture is refunded and says look_unavailable; the photo of a good one carries `moved`", async () => {
    const h = harness();
    const refunds: string[] = [];
    h.fail();
    const bad = h.q.submit("a", pose, { refund: async (j) => { refunds.push(j.id); } }) as { job: SeeJob };
    h.release(); await h.q.wait(bad.job, 100);
    expect([bad.job.state, bad.job.error, refunds.length]).toEqual(["failed", "look_unavailable", 1]);
    const h2 = harness();
    const ok = h2.q.submit("a", pose, { moved: async () => ({ distanceM: 4.2, turnedDeg: 30 }) }) as { job: SeeJob };
    h2.release(); await h2.q.wait(ok.job, 100);
    expect(ok.job.state).toBe("done");
    expect(ok.job.moved).toEqual({ distanceM: 4.2, turnedDeg: 30 });
  });

  test("a full queue is busy; jobs belong to their agent; finished jobs expire", async () => {
    const h = harness({ maxQueue: 1, keepMs: 1000 });
    h.q.submit("a", pose); // running
    h.q.submit("b", pose); // queued (1/1)
    expect(h.q.submit("c", pose)).toEqual({ ok: false, reason: "busy" });
    const a = h.q.submit("a", pose);
    expect(a.ok).toBe(false); // in flight takes precedence
    h.release(); await flush(); h.release(); await flush();
    const mine = h.q.submit("z", pose) as { ok: true; job: SeeJob };
    expect(h.q.get("z", mine.job.id)).toBeDefined();
    expect(h.q.get("someone-else", mine.job.id)).toBeUndefined();
  });

  test("cancelAgent drops a job still waiting its turn", async () => {
    const h = harness();
    h.q.submit("a", pose);
    const b = h.q.submit("b", pose) as { job: SeeJob };
    h.q.cancelAgent("b"); await flush();
    expect([b.job.state, b.job.error]).toEqual(["failed", "cancelled"]);
  });

  test("seeView hides the owner and shows the age", () => {
    const job: SeeJob = { id: "i", agentId: "secret-agent", state: "queued", requestedAt: 1000, pose };
    const v = seeView(job, 4500) as Record<string, unknown>;
    expect(v.agentId).toBeUndefined();
    expect(v.ageMs).toBe(3500);
  });

  test("angleDiffDeg wraps", () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(90, 90)).toBe(0);
    expect(angleDiffDeg(0, 180)).toBe(180);
  });
});
