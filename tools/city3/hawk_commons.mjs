// Install the authored Hawk Lane commons modules and the neighboring lot's porch collision.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBounds, NodeIO } from "@gltf-transform/core";
import { placeProps } from "./place_props.mjs";

const modules = process.argv[2];
if (!modules) throw new Error("Pass the output directory from hawk_commons_mesh.py");

const assets = "apps/console/public/assets";
const id = "hawk-lane-commons";
const bench = [32.6, -151.85];
const gravelY = 0.245;
const floorY = 0.20;
const source = (name) => join(modules, `${name}.glb`);
const walks = await new NodeIO().read(source("walks"));
const { min, max } = getBounds(walks.getRoot().listScenes()[0]);

await placeProps({
  id, name: "Hawk Lane Commons", center: [35, -145], half: 15, y: gravelY,
  props: [
    {
      name: "walks", src: source("walks"), col: null, y: min[1],
      at: [[(min[0] + max[0]) / 2, (min[2] + max[2]) / 2, 0]],
    },
    { name: "bench", src: source("bench"), col: [1.01, 0.27, 0.875], at: [[...bench, 0]] },
    {
      name: "planting", src: source("planting"), col: [0.675, 0.34, 0.48], y: 0.229,
      at: [[30.37, -150.58, 90], [34.86, -151.18, 90], [33.72, -153.05, 0]],
    },
  ],
});

const read = (name) => JSON.parse(readFileSync(`${assets}/${name}`, "utf8"));
const write = (name, value, indent) => writeFileSync(`${assets}/${name}`, JSON.stringify(value, null, indent));
function upsert(name, rows, indent) {
  const existing = read(name);
  const byId = new Map(existing.map(row => [row.id, row]));
  for (const row of rows) byId.set(row.id, row);
  write(name, [...byId.values()], indent);
}

const manifest = read("districts.json");
const neighbor = manifest.districts.find(d => d.id === "house-ring-35-1");
if (neighbor?.origin?.join() !== "46.2,-148.2" || neighbor.url !== "/assets/houses/american-y0.glb") {
  throw new Error("The porch collision is fitted to the original American house on ring-35-1");
}
const collision = "houses/american-ring-35-1.col.glb";
copyFileSync(source("porch-collision"), `${assets}/${collision}`);
neighbor.collisionUrl = `/assets/${collision}`;
write("districts.json", manifest, 1);

upsert("city3-places.json", [
  { id, name: "Hawk Lane Commons", kind: "landmark", pos: bench, stand: [32.6, -150.56], heading: Math.PI },
  { id: "hawk-lane-neighbor-porch", name: "Hawk Lane Porch", kind: "landmark", pos: [41.74, -143.95], stand: [41.74, -142.85], heading: Math.PI },
], 1);

upsert("city3-anchors.json", [{
  id: "hawk-lane-bench", building: id, kind: "bench", seat: bench, facing: 0,
  approach: [32.6, -150.80], approachSide: "front", floorY, seatHeight: gravelY + 0.46 - floorY,
}]);
