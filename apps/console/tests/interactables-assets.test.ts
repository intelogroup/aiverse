// @vitest-environment node
// The Tea House radio as shipped: the generated definition (public/assets/interiors/index.json) against the real
// furniture collision (tea.col.json). Lives outside src/ like glb-inventory.test.ts (the app tsconfig is browser-typed).
// Guards the one thing a flat-floor unit test cannot: the stand point is REACHABLE by a 0.4 m walker through the
// Tea House's actual tables, and a session on it completes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxesMesh, createCapsuleWorld, meshFromArrays } from "../src/features/world/capsuleWorld";
import { clipDef } from "../src/features/world/clips";
import { INTERACT_CLIP, InteractController, type InteractableDef } from "../src/features/world/interactables";
import { makeWalker, step, type World } from "../src/features/world/walker";

const dir = new URL("../public/assets/interiors/", import.meta.url);
const idx = JSON.parse(readFileSync(new URL("index.json", dir), "utf8")) as { id: string; rect: [number, number, number, number]; interactables?: InteractableDef[] }[];
const tea = idx.find((r) => r.id === "tea")!;
const col = JSON.parse(readFileSync(new URL("tea.col.json", dir), "utf8")) as {
  floorY: number;
  boxes: [number, number, number, number, number, number, number][];
};

function teaWorld(): World {
  const [x0, z0, x1, z1] = tea.rect;
  const y = col.floorY;
  const ground = meshFromArrays(new Float32Array([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0]), new Uint32Array([0, 1, 2, 0, 2, 3]), "tea-floor");
  const meshes = [ground, boxesMesh(col.boxes, [0, 0], "tea-furniture")!];
  return createCapsuleWorld(() => meshes);
}

describe("the Tea House radio as shipped", () => {
  const def = tea.interactables![0];

  it("is listed once, as the radio asset, with an authored pilot light", () => {
    expect(tea.interactables).toHaveLength(1);
    expect(def).toMatchObject({ id: "tea-radio", kind: "radio", asset: "vintage_radio_transceiver" });
    expect(def.pilot).toHaveLength(3);
  });

  it("a 0.4 m walker reaches the stand pose through the real furniture from several sides, and the session completes", () => {
    const world = teaWorld();
    const starts: [number, number][] = [[1.4, 1.0], [1.8, -0.8], [0.9, 0.0]];
    for (const [dx, dz] of starts) {
      const ctl = new InteractController();
      ctl.register([def]);
      let t = 0;
      let cur: { at: number } | null = null;
      const channel = {
        fire: (n: string) => ((cur = { at: t }), n === INTERACT_CLIP),
        get current() { return cur && t - cur.at < (clipDef(INTERACT_CLIP)?.duration ?? 3.23) ? INTERACT_CLIP : null; },
      };
      const s = makeWalker(def.stand[0] + dx, col.floorY, def.stand[1] + dz, 2.0);
      const flips: boolean[] = [];
      ctl.subscribe((_i, on) => flips.push(on));
      ctl.drive(s, 1 / 60, "player"); // seen
      expect(ctl.request(def.id, "player", channel)).toBe("started");
      for (let f = 0; f < 60 * 25 && ctl.sessionOf("player"); f++) {
        t += 1 / 60;
        const input = ctl.drive(s, 1 / 60, "player");
        ctl.tick(1 / 60);
        step(s, input ?? { forward: 0, strafe: 0, turn: 0, run: false }, 1 / 60, world);
      }
      expect(flips, `start offset (${dx}, ${dz})`).toEqual([true]);
      expect(Math.hypot(s.x - def.stand[0], s.z - def.stand[1])).toBeLessThan(0.06);
    }
  });
});
