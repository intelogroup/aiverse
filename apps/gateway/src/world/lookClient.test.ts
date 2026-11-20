import { afterEach, describe, expect, test } from "bun:test";
import { httpLookClient } from "./lookClient";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const answer = (camera: unknown, checkRequest?: (body: unknown) => void) => {
  globalThis.fetch = (async (_url, init) => {
    checkRequest?.(JSON.parse(init!.body as string));
    return Response.json({ png_b64: "AAAA", width: 1024, height: 576, camera });
  }) as typeof fetch;
};
const worldFromCamera = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 1, 9.45, 2, 1];

describe("httpLookClient camera pose", () => {
  test("sends all three coordinates and accepts a camera at the body's eye height and gaze", async () => {
    answer({ worldFromCamera }, (request) => expect(request).toMatchObject({ position3d: [1, 7.9, 2], headingDeg: 0, pitchDeg: 0 }));
    const r = await httpLookClient("http://look", "s".repeat(32)).look("a", [1, 7.9, 2], 10, { yawDeg: -10, pitchDeg: 0 });
    expect(r).toMatchObject({ ok: true, frame: { width: 1024, height: 576 } });
  });
  test("rejects an unverified, wrong-floor or wrong-gaze image", async () => {
    const client = httpLookClient("http://look", "s".repeat(32));
    answer(null);
    expect(await client.look("a", [1, 7.9, 2], 0)).toMatchObject({ ok: false, reason: "bad_response" });
    answer({ worldFromCamera });
    expect(await client.look("a", [1, .48, 2], 0)).toMatchObject({ ok: false, reason: "bad_response" });
    expect(await client.look("a", [1, 7.9, 2], 90)).toMatchObject({ ok: false, reason: "bad_response" });
  });
});
