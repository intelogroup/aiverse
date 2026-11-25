// Mount the Hawk Lane overlook on the existing waterfront pavement.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { placeProps } from "./place_props.mjs";

const railModules = process.argv[2];
const benchModules = process.argv[3];
const binSource = process.argv[4];
if (!railModules || !benchModules || !binSource) {
  throw new Error("Pass the overlook and commons Blender output directories and metal_trash_can_1k.gltf");
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const bin = await io.read(binSource);
const binScene = bin.getRoot().listScenes()[0];
const parts = ["metal_trash_can", "metal_trash_can_lid", "metal_trash_can_handle_left", "metal_trash_can_handle_right"];
for (const node of binScene.listChildren()) {
  if (!parts.includes(node.getName())) binScene.removeChild(node);
}
if (binScene.listChildren().length !== parts.length) throw new Error("Incomplete clean trash can assembly");
const lid = binScene.listChildren().find(node => node.getName() === "metal_trash_can_lid");
// The source displays its lid on edge. Seat the skirt over the measured 0.906 m rim.
lid.setRotation([0, 0, 0, 1]).setTranslation([0.5, 0.928, 0]);
await bin.transform(prune());
const binModule = join(railModules, "overlook-bin.glb");
await io.write(binModule, bin);

const id = "hawk-lane-overlook";
const x = 37.85;
const railZ = -179.86;
const benchZ = -178.48;
const floorY = 0.2;
const benchY = floorY + 0.025;

await placeProps({
  id, name: "Hawk Lane Overlook", center: [x, -178.9], half: 6, y: floorY,
  props: [
    { name: "overlook-railing", src: join(railModules, "overlook-railing.glb"),
      col: [5.72, 0.09, 1.145], at: [[x, railZ, 0]] },
    { name: "overlook-decking", src: join(railModules, "overlook-decking.glb"),
      col: null, at: [[x, -178.86, 0]] },
    { name: "overlook-bench", src: join(benchModules, "bench.glb"),
      y: benchY, col: [1.01, 0.27, 0.875], at: [[x, benchZ, 180]] },
    { name: "overlook-bin", src: binModule, scale: 0.82,
      col: [0.267, 0.229, 0.825], at: [[33.7, -179.07, 0]] },
  ],
});

function upsert(file, row, indent) {
  const path = `apps/console/public/assets/${file}`;
  const rows = JSON.parse(readFileSync(path, "utf8"));
  const index = rows.findIndex(entry => entry.id === row.id);
  if (index === -1) rows.push(row);
  else rows[index] = row;
  writeFileSync(path, JSON.stringify(rows, null, indent));
}

upsert("city3-places.json", {
  id, name: "Hawk Lane Overlook", kind: "landmark",
  pos: [x, benchZ], stand: [x, -177.42], heading: Math.PI,
}, 1);
upsert("city3-anchors.json", {
  id: "hawk-lane-overlook-bench", building: id, kind: "bench", seat: [x, benchZ],
  facing: Math.PI, approach: [x, -179.30], approachSide: "front",
  seatHeight: benchY + 0.46 - floorY, floorY,
});
