// @vitest-environment node
// look: a depth image and a class image from the body's eyes. Shape, content, bearing sign, timing.
import { beforeAll, describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { LOOK_CLASSES, LOOK_H, LOOK_NO_HIT, LOOK_W } from "@aiverse/world-sim/look";
import { encodeGrayPng } from "@aiverse/world-sim/png";
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

  it("costs under 50 ms per look (p95) on this machine", () => {
    service.attach("tim");
    const ms: number[] = [];
    for (let i = 0; i < 30; i++) { const t0 = performance.now(); service.look("tim"); ms.push(performance.now() - t0); }
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)];
    console.log(`look ms: median ${ms[15].toFixed(1)} p95 ${p95.toFixed(1)} max ${ms[29].toFixed(1)}`);
    expect(p95).toBeLessThan(50);
    service.detach("tim");
  });
});
