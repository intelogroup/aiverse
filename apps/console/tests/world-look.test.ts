// @vitest-environment node
// look: a depth image and a class image from the body's eyes. Shape, content, bearing sign, timing.
import { beforeAll, describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { LOOK_CLASSES, LOOK_H, LOOK_NO_HIT, LOOK_W } from "@aiverse/world-sim/look";
import { encodeGrayPng } from "@aiverse/world-sim/png";
import { explainAction } from "@aiverse/world-sim/actionProtocol";
import { WorldService } from "@aiverse/world-sim/worldService";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
let service: WorldService;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => {
  ({ sim } = await loadVerseSim(ASSETS));
  service = new WorldService({ sim, maxBodies: 8 });
}, 120_000);

async function settle(agent: string, id: string, maxS = 30) {
  for (let t = 0; t < maxS * 10; t++) {
    const rec = service.actRecord(agent, id)!;
    if (rec.state !== "running") return rec;
    service.tick(0.1);
    await Promise.resolve();
  }
  return service.actRecord(agent, id)!;
}

/** Decode a grey PNG written by encodeGrayPng back to samples (checks it is a real PNG: signature, IHDR, IDAT inflates). */
function decode(b64: string) {
  const buf = Buffer.from(b64, "base64");
  expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), bits = buf[24];
  let at = 8, idat = Buffer.alloc(0);
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") idat = Buffer.concat([idat, buf.subarray(at + 8, at + 8 + len)]);
    at += 12 + len;
  }
  const raw = inflateSync(idat), bpp = bits / 8, out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * bpp + 1) + 1 + x * bpp;
    out[y * w + x] = bits === 16 ? (raw[o] << 8) | raw[o + 1] : raw[o];
  }
  return { w, h, bits, px: out };
}

describe("look", () => {
  it("png encoder round-trips 8 and 16 bit samples", () => {
    const s16 = Uint16Array.from({ length: 6 }, (_, i) => i * 10000), s8 = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    const a = decode(Buffer.from(encodeGrayPng(3, 2, 16, s16)).toString("base64"));
    const b = decode(Buffer.from(encodeGrayPng(3, 2, 8, s8)).toString("base64"));
    expect([a.w, a.h, a.bits]).toEqual([3, 2, 16]);
    expect([...a.px]).toEqual([...s16]);
    expect([b.bits, [...b.px]]).toEqual([8, [...s8]]);
  });

  it("returns two PNGs of the right size, a legend, and the scene read at the same instant", () => {
    service.attach("amy");
    const v = service.look("amy");
    const d = decode(v.depthPng), c = decode(v.classPng);
    expect([d.w, d.h, d.bits]).toEqual([LOOK_W, LOOK_H, 16]);
    expect([c.w, c.h, c.bits]).toEqual([LOOK_W, LOOK_H, 8]);
    expect(v.legend[LOOK_CLASSES.floor]).toBe("floor");
    expect(v.camera.hfovDeg).toBe(86);
    expect(v.observation.body.id).toBeDefined();
    // standing on the ground: the bottom rows see floor, a few metres out
    const bottom = c.px[(LOOK_H - 1) * LOOK_W + LOOK_W / 2];
    expect(bottom).toBe(LOOK_CLASSES.floor);
    const dmm = d.px[(LOOK_H - 1) * LOOK_W + LOOK_W / 2];
    expect(dmm).toBeGreaterThan(500);
    expect(dmm).toBeLessThan(6000);
    // looking at the sky: nothing within range
    expect(d.px[0 * LOOK_W + LOOK_W / 2] === LOOK_NO_HIT || c.px[LOOK_W / 2] !== LOOK_CLASSES.floor).toBe(true);
  });

  it("another body ahead shows as the body class at about its distance; to the right it lands in the right half; behind it is absent", async () => {
    const { x, z } = service.body("amy");
    service.attach("ben", { x: x + 4, z });
    await settle("amy", service.act("amy", "l0", { type: "face", point: [x + 4, z] }).id);
    const v = service.look("amy");
    const c = decode(v.classPng), d = decode(v.depthPng);
    let n = 0, cols = 0, depth = 0;
    for (let j = 0; j < LOOK_H; j++) for (let i = 0; i < LOOK_W; i++) if (c.px[j * LOOK_W + i] === LOOK_CLASSES.body) { n++; cols += i; depth += d.px[j * LOOK_W + i]; }
    expect(n, "ben fills some pixels").toBeGreaterThan(20);
    expect(Math.abs(cols / n - LOOK_W / 2), "centred").toBeLessThan(6);
    expect(Math.abs(depth / n - 4000), "about 4 m (cylinder surface, 0.4 m radius)").toBeLessThan(700);
    // turn 40 degrees to the left of ben: ben is now to the right in the picture, matching positive bearing in observe
    const bearing = v.observation.scene.find((o) => o.kind === "body")!.bearingDeg;
    expect(Math.abs(bearing)).toBeLessThan(10);
    await settle("amy", service.act("amy", "l1", { type: "face", headingDeg: -40 + (service.body("amy").heading * 180) / Math.PI }).id);
    const turned = service.look("amy"), tc = decode(turned.classPng);
    const right = turned.observation.scene.find((o) => o.kind === "body")!.bearingDeg;
    let sum = 0, m = 0;
    for (let j = 0; j < LOOK_H; j++) for (let i = 0; i < LOOK_W; i++) if (tc.px[j * LOOK_W + i] === LOOK_CLASSES.body) { sum += i; m++; }
    if (m > 0 && Math.abs(right) < 40) expect(sum / m > LOOK_W / 2, `bearing ${right} deg means right of centre`).toBe(right > 0);
    // face away: ben is behind, no body pixels
    await settle("amy", service.act("amy", "l2", { type: "face", point: [x - 20, z] }).id);
    const away = decode(service.look("amy").classPng);
    expect([...away.px].includes(LOOK_CLASSES.body)).toBe(false);
    service.detach("ben");
  });

  it("gaze turns the head, not the body: yaw moves another body across the picture, pitch trades floor for sky, reset restores", async () => {
    service.attach("gz");
    const { x, z } = service.body("gz");
    service.attach("gt", { x: x + 5, z });
    const t = service.body("gt"); // the spawn may have moved it: face where it really stands
    await settle("gz", service.act("gz", "g0", { type: "face", point: [t.x, t.z] }).id);
    const count = (v: ReturnType<WorldService["look"]>, cls: number) => { const c = decode(v.classPng); let n = 0, sum = 0; for (let j = 0; j < LOOK_H; j++) for (let i = 0; i < LOOK_W; i++) if (c.px[j * LOOK_W + i] === cls) { n++; sum += i; } return { n, mean: n ? sum / n : 0 }; };
    const ahead = count(service.look("gz"), LOOK_CLASSES.body);
    expect(Math.abs(ahead.mean - LOOK_W / 2), "centred before gaze").toBeLessThan(8);
    // head 30 degrees to the left: the body is to the RIGHT in the picture; the body itself did not turn
    const heading0 = service.body("gz").heading;
    const r = await settle("gz", service.act("gz", "g1", { type: "gaze", yawDeg: -30 }).id);
    expect(r.outcome?.status).toBe("done");
    expect(service.body("gz").heading).toBe(heading0);
    expect(service.body("gz").gaze).toEqual({ yawDeg: -30, pitchDeg: 0 });
    const left = count(service.look("gz"), LOOK_CLASSES.body);
    expect(left.n, "still in the 86 degree field").toBeGreaterThan(10);
    expect(left.mean, "to the right of centre").toBeGreaterThan(LOOK_W / 2 + 15);
    // yaw past the field of view: nothing
    await settle("gz", service.act("gz", "g2", { type: "gaze", yawDeg: 60 }).id);
    expect(count(service.look("gz"), LOOK_CLASSES.body).n).toBe(0);
    // pitch: looking up shows more sky and less floor than looking down (pitch alone keeps the earlier yaw until reset)
    await settle("gz", service.act("gz", "g3", { type: "gaze", reset: true }).id);
    expect(service.body("gz").gaze).toEqual({ yawDeg: 0, pitchDeg: 0 });
    await settle("gz", service.act("gz", "g4", { type: "gaze", pitchDeg: 40 }).id);
    const up = service.look("gz");
    await settle("gz", service.act("gz", "g5", { type: "gaze", pitchDeg: -50 }).id);
    const down = service.look("gz");
    expect(up.camera.gaze).toEqual({ yawDeg: 0, pitchDeg: 40 });
    expect(count(up, LOOK_CLASSES.sky).n).toBeGreaterThan(count(down, LOOK_CLASSES.sky).n);
    expect(count(down, LOOK_CLASSES.floor).n).toBeGreaterThan(count(up, LOOK_CLASSES.floor).n);
    // the ordinary observation reports it
    expect(service.observe("gz").body.gaze).toEqual({ yawDeg: 0, pitchDeg: -50 });
    service.detach("gt");
    service.detach("gz");
  });

  it("gaze validation names the limits", () => {
    const why = (a: unknown) => explainAction(a);
    expect(why({ type: "gaze", yawDeg: 90 })).toMatch(/yawDeg must be within \+-70/);
    expect(why({ type: "gaze", pitchDeg: 80 })).toMatch(/pitchDeg must be between -60 and 45/);
    expect(why({ type: "gaze" })).toMatch(/needs yawDeg and\/or pitchDeg, or reset:true/);
    expect(why({ type: "gaze", reset: true, yawDeg: 10 })).toMatch(/reset must be true and used alone/);
    expect(why({ type: "gaze", yawDeg: 10, pitchDeg: -20 })).toBeNull();
    expect(why({ type: "gaze", reset: true })).toBeNull();
  });

  it("a wall is a wall: inside a shop facing the back wall, no sky and a near wall", async () => {
    const lot = sim.places.find((p) => p.id === "shop-65")!;
    service.attach("eve", { x: lot.stand[0], z: lot.stand[1] });
    await settle("eve", service.act("eve", "e1", { type: "enter", place: "shop-65" }).id, 120);
    const door = sim.rooms.find((r) => r.id === "shop-65")!.door;
    const me = service.body("eve");
    await settle("eve", service.act("eve", "e2", { type: "face", point: [me.x + (me.x - door[0]) * 10, me.z + (me.z - door[1]) * 10] }).id);
    const v = service.look("eve"), c = decode(v.classPng);
    const mid = c.px[(LOOK_H / 2) * LOOK_W + LOOK_W / 2];
    expect(mid).toBe(LOOK_CLASSES.wall);
    service.detach("eve");
  }, 60_000);

  it("a shop door reads as door from outside and from inside, and the wall beside it stays wall", async () => {
    const room = sim.rooms.find((r) => r.id === "shop-65")!;
    const [x0, z0, x1, z1] = room.rect, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const [dx, dz] = room.door;
    // outward = the way from the room centre to its door, snapped to the wall axis
    const ox = Math.abs(dx - cx) > Math.abs(dz - cz) ? Math.sign(dx - cx) : 0, oz = ox === 0 ? Math.sign(dz - cz) : 0;
    service.attach("dora", { x: dx + ox * 3, z: dz + oz * 3 });
    await settle("dora", service.act("dora", "d1", { type: "face", point: [dx, dz] }).id);
    const centre = (c: ReturnType<typeof decode>) => c.px[(LOOK_H / 2) * LOOK_W + LOOK_W / 2];
    const out = service.look("dora");
    expect(centre(decode(out.classPng)), "from outside").toBe(LOOK_CLASSES.door);
    expect(out.legend[LOOK_CLASSES.door]).toBe("door");
    const dmm = decode(out.depthPng).px[(LOOK_H / 2) * LOOK_W + LOOK_W / 2];
    expect(Math.abs(dmm - 3000), "about 3 m").toBeLessThan(500);
    // 2.5 m along the wall from the door, looking straight at the wall: wall, not door
    const side = { x: dx + oz * 2.5 + ox * 3, z: dz + ox * 2.5 + oz * 3 };
    service.detach("dora");
    service.attach("wally", { x: side.x, z: side.z });
    await settle("wally", service.act("wally", "w1", { type: "face", point: [side.x - ox * 3, side.z - oz * 3] }).id);
    expect(centre(decode(service.look("wally").classPng)), "the wall beside the door").toBe(LOOK_CLASSES.wall);
    service.detach("wally");
  }, 60_000);

  it("the adaptive pass matches a full 9,216-ray render at spread-out places (class 99%+, depth within 3% / 50 mm 99%+)", () => {
    const spots = sim.places.filter((_p, i) => i % Math.ceil(sim.places.length / 8) === 0).slice(0, 8);
    let cls = 0, dep = 0, tot = 0;
    spots.forEach((p, i) => {
      const id = `acc${i}`;
      service.attach(id, { x: p.stand[0], z: p.stand[1] });
      const ad = sim.look(id)!, fu = sim.look(id, 25, { full: true })!;
      for (let k = 0; k < ad.classes.length; k++) {
        cls += ad.classes[k] === fu.classes[k] ? 1 : 0;
        const a = ad.depthMm[k], b = fu.depthMm[k];
        dep += a === b || (a < LOOK_NO_HIT && b < LOOK_NO_HIT && Math.abs(a - b) <= Math.max(50, 0.03 * b)) ? 1 : 0;
        tot++;
      }
      service.detach(id);
    });
    expect(cls / tot).toBeGreaterThan(0.99);
    expect(dep / tot).toBeGreaterThan(0.99);
  });

  it("costs under 50 ms per look (p95) across the city, shops included", () => {
    const spots = sim.places.filter((_p, i) => i % Math.ceil(sim.places.length / 20) === 0).slice(0, 20);
    const ms: number[] = [];
    spots.forEach((p, i) => {
      const id = `lat${i}`;
      service.attach(id, { x: p.stand[0], z: p.stand[1] });
      service.look(id); // warm
      for (let k = 0; k < 3; k++) { const t0 = performance.now(); service.look(id); ms.push(performance.now() - t0); }
      service.detach(id);
    });
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)];
    console.log(`look ms over ${ms.length} looks: median ${ms[Math.floor(ms.length / 2)].toFixed(1)} p95 ${p95.toFixed(1)} max ${ms[ms.length - 1].toFixed(1)}`);
    expect(p95).toBeLessThan(50);
  });
});
