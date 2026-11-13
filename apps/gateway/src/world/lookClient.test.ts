import { afterEach, describe, expect, test } from "bun:test";
import { httpLookClient } from "./lookClient";

// The client's parse of the service's answer: the pose error fields the camera rig adds (and an older rig's answer without them).
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const answer = (extra: Record<string, unknown>) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, png_b64: "AAAA", width: 512, height: 288, pitchSupported: true, ...extra }), { status: 200 })) as unknown as typeof fetch;
};

describe("httpLookClient pose error", () => {
  test("passes the service's poseErrorM and poseMismatch through", async () => {
    answer({ poseErrorM: 2.41, poseMismatch: true });
    const r = await httpLookClient("http://look", "s".repeat(32)).look("a", [1, 2], 90);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.frame.poseErrorM, r.frame.poseMismatch]).toEqual([2.41, true]);
  });
  test("an older service without the fields gives null / false, never a made-up number", async () => {
    answer({});
    const r = await httpLookClient("http://look", "s".repeat(32)).look("a", [1, 2], 90);
    if (r.ok) expect([r.frame.poseErrorM, r.frame.poseMismatch]).toEqual([null, false]);
    else throw new Error("expected ok");
  });
});
