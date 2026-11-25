// Place the three fitted scan variants and the crate stack prepared by hawk_lane_finish_mesh.py.
import { join } from "node:path";
import { placeProps } from "./place_props.mjs";

const modules = process.argv[2];
if (!modules) throw new Error("Pass the directory baked by hawk_lane_finish_mesh.py");

const variants = ["flagstone-long", "flagstone-round", "flagstone-small"];
const offsets = [-0.13, 0.08, 0.16, -0.04, 0.10, -0.16];
const rotations = [-12, 5, 17, 0, 10, -7, 13];
const stones = Array.from({ length: 24 }, (_, i) => ({
  model: variants[i % variants.length],
  at: [13.10 + 1.12 * i, -157.5 + offsets[i % offsets.length], rotations[i % rotations.length]],
}));

await placeProps({
  id: "hawk-lane-finish", name: "Hawk Lane trail and waterfront", center: [26, -166.7], half: 20, y: 0.2,
  props: [
    ...variants.map(name => ({
      name, src: join(modules, `${name}.glb`), y: 0.195, col: null,
      at: stones.filter(stone => stone.model === name).map(stone => stone.at),
    })),
    { name: "waterfront-crates", src: join(modules, "waterfront-crates.glb"),
      col: [0.413, 0.205, 0.61], at: [[28.8, -178.8, 0]] },
  ],
});
