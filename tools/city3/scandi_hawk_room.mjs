// Assemble the ground-floor fittings split from Hawk Lane with the CC0 furnishings.
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, mergeDocuments, metalRough, prune } from "@gltf-transform/functions";
import { readFileSync, writeFileSync } from "node:fs";

const [contentsPath, kitPath, downloads] = process.argv.slice(2);
if (!contentsPath || !kitPath || !downloads) throw new Error("Usage: bun tools/city3/scandi_hawk_room.mjs contents.glb interior-kit.glb downloads-dir");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const contents = await io.read(contentsPath);
const scene = contents.getRoot().listScenes()[0];
const fittings = contents.createNode("LIB_hawk_fittings");
for (const child of scene.listChildren()) {
  scene.removeChild(child);
  fittings.addChild(child);
}
scene.addChild(fittings);

const id = "house-ring-35-0";
const dir = "apps/console/public/assets/interiors";
const library = "scandi-hawk-interior.glb";
const col = JSON.parse(readFileSync(`${dir}/${id}.col.json`, "utf8"));
const y = col.floorY;
const loftY = 3.36;
// Use the rendered surfaces for furniture and keep the walkable slabs at their collision heights.
const woodFloorY = y + 0.005;
const loftDeckY = loftY - 0.005;
// Canopy tops measured on the exported meshes: 3.190 m on the flat ceiling
// between joists and 6.361 m across the loft ridge's flat mounting face.
const livingPendantY = 2.595;
const loftLampY = 6.167;
const loftLampX = 22.87;
const nightstand = { x: 21.08, z: -142.79 };
const props = [
  ["hawk_fittings", 23.8, y - 0.405, -146.3, 0, 1],
  ["hawk_sofa", 25.85, woodFloorY, -143.90, -Math.PI / 2, 1],
  ["hawk_rug", 24.8, woodFloorY, -143.90, Math.PI / 2, 0.9],
  ["hawk_pendant", 24.55, livingPendantY, -143.90, 0, 1],
  ["coffee_table", 24.30, woodFloorY, -143.90, 0, 0.9],
  ["side_table", 25.85, woodFloorY, -142.54, 0, 1],
  ["vase_ceramic", 25.85, woodFloorY + 0.5, -142.54, 0, 0.68],
  ["plant_pot_4", 26.45, woodFloorY, -142.65, 0, 1],
  ["bar_chair", 20.05, y, -144.65, 0, 1],
  ["bar_chair", 21.15, y, -144.65, 0, 1],
  ["loft_bed", 21.89, loftDeckY, -143.70, Math.PI, 1],
  ["loft_nightstand", nightstand.x, loftDeckY, nightstand.z, 0, 0.9],
  ["loft_lamp", loftLampX, loftLampY, -144.20, 0, 0.45],
];

const kit = await io.read(kitPath);
const kitScene = kit.getRoot().listScenes()[0];
const keys = new Set(props.slice(1).map(([key]) => `LIB_${key}`));
for (const node of kitScene.listChildren()) {
  if (!keys.has(node.getName())) kitScene.removeChild(node);
}
await kit.transform(prune());
const mapped = mergeDocuments(contents, kit);
for (const child of kitScene.listChildren()) scene.addChild(mapped.get(child));
mapped.get(kitScene).dispose();
for (const [key, sourcePath, scale] of [
  ["hawk_sofa", "int-sofa/model.glb", 1.15],
  ["hawk_rug", "int-rug/model.glb", 1],
  ["hawk_pendant", "int-pendant-bell/model.glb", 0.018],
  ["loft_bed", "polyhaven-models/vintage_day_bed/vintage_day_bed_1k.gltf", 1],
  ["loft_nightstand", "polyhaven-models/painted_wooden_nightstand/painted_wooden_nightstand_1k.gltf", 0.9],
  ["loft_lamp", "polyhaven-models/modern_ceiling_lamp_01/modern_ceiling_lamp_01_1k.gltf", 0.45],
]) {
  const source = await io.read(`${downloads}/${sourcePath}`);
  if (source.getRoot().listExtensionsUsed().some((e) => e.extensionName === "KHR_materials_pbrSpecularGlossiness")) {
    await source.transform(metalRough());
  }
  const original = source.getRoot().listScenes()[0];
  const { min, max } = getBounds(original);
  const wrapper = source.createNode().setScale([scale, scale, scale]).setTranslation([
    -(min[0] + max[0]) * scale / 2,
    -min[1] * scale,
    -(min[2] + max[2]) * scale / 2,
  ]);
  for (const child of original.listChildren()) {
    original.removeChild(child);
    wrapper.addChild(child);
  }
  original.addChild(wrapper);
  await source.transform(flatten(), join({ keepNamed: false }), prune());
  const imported = mergeDocuments(contents, source);
  const root = contents.createNode(`LIB_${key}`);
  for (const child of original.listChildren()) root.addChild(imported.get(child));
  scene.addChild(root);
  imported.get(original).dispose();
}
const available = new Set(scene.listChildren().map((node) => node.getName()));
for (const [key] of props) {
  if (!available.has(`LIB_${key}`)) throw new Error(`Missing interior library asset: ${key}`);
}
const buffer = contents.getRoot().listBuffers()[0];
for (const accessor of contents.getRoot().listAccessors()) accessor.setBuffer(buffer);

await contents.transform(prune(), dedup());
await io.write(`${dir}/${library}`, contents);

col.boxes = [
  [25.85, -143.90, 0.45, 1.15, y, y + 0.7, 0],
  [24.30, -143.90, 0.43, 0.43, y, y + 0.32, 0],
  [25.85, -142.54, 0.25, 0.205, y, y + 0.5, 0],
  [20.25, -143.76, 1.42, 0.38, y, y + 0.9, 0],
  [20.05, -144.65, 0.25, 0.25, y, y + 0.78, 0],
  [21.15, -144.65, 0.25, 0.25, y, y + 0.78, 0],
];
// Measured tread nosings. The first three turn around the east wall.
const stairs = [
  [26.90, 26.08, -146.21, -145.89, 0.72],
  [26.90, 25.92, -146.47, -146.19, 0.92],
  [26.90, 25.83, -146.86, -146.42, 1.12],
  [26.46, 25.74, -146.86, -146.05, 1.32],
  [26.05, 25.60, -146.86, -146.05, 1.52],
  [25.70, 25.41, -146.86, -146.05, 1.72],
  [25.41, 25.17, -146.86, -146.05, 1.92],
  [25.17, 24.92, -146.86, -146.05, 2.11],
  [24.92, 24.68, -146.86, -146.05, 2.31],
  [24.68, 24.43, -146.86, -146.05, 2.51],
  [24.43, 24.19, -146.86, -146.05, 2.71],
  [24.19, 23.95, -146.86, -146.05, 2.91],
  [23.95, 23.66, -146.86, -146.05, 3.11],
  [23.66, 22.38, -147.12, -145.62, 3.36],
];
col.walkableBoxes = stairs.map(([right, left, front, back, top]) =>
  [(left + right) / 2, (front + back) / 2, (right - left) / 2, (back - front) / 2, top - 0.045, top, 0]);
// The south gable has continuous decking. Hold the walking route under the
// taller part of the roof, and guard the stair void either side of the opening.
col.walkableBoxes.push([22.97, -143.96, 2.25, 1.66, loftY - 0.045, loftY, 0]);
col.boxes.push(
  [22.38, -146.37, 0.04, 0.75, 3.36, 4.5, 0],
  [23.02, -147.12, 0.66, 0.04, 3.36, 4.5, 0],
  [21.55, -145.62, 0.84, 0.04, loftY, 4.5, 0],
  [24.44, -145.62, 0.78, 0.04, loftY, 4.5, 0],
  [20.72, -143.96, 0.04, 1.66, loftY, 4.5, 0],
  [25.22, -143.96, 0.04, 1.66, loftY, 4.5, 0],
  [22.97, -142.30, 2.25, 0.04, loftY, 4.5, 0],
  [21.89, -143.70, 0.985, 0.425, loftDeckY, loftDeckY + 1.127, 0],
  [nightstand.x, nightstand.z, 0.227, 0.229, loftDeckY, loftDeckY + 0.554, 0],
);

writeFileSync(`${dir}/${id}.json`, JSON.stringify({ id, library, props, lights: [[24.55, livingPendantY - 0.05, -143.90, "#ffe2bd", 24], [20.6, y + 2.05, -147.3, "#fff1df", 19], [loftLampX, loftLampY - 0.181, -144.20, "#ffe9ca", 21]] }));
writeFileSync(`${dir}/${id}.col.json`, JSON.stringify(col));


// The seat surface was measured on the exported cushion mesh in world space.
const anchorsPath = "apps/console/public/assets/city3-anchors.json";
const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));
const seat = {
  id: "scandi-hawk-sofa", building: id, kind: "sofa",
  seat: [25.52, -144.58], facing: -Math.PI / 2,
  approach: [24.9, -144.67], approachSide: "front", seatHeight: 0.369, floorY: y,
};
const bed = {
  id: "scandi-hawk-loft-bed", building: id, kind: "bed",
  seat: [22.55, -143.93], facing: Math.PI / 2,
  approach: [23.37, -143.60], approachSide: "front", seatHeight: 0.515, floorY: loftY,
};
writeFileSync(anchorsPath, JSON.stringify([
  ...anchors.filter((anchor) => anchor.id !== seat.id && anchor.id !== bed.id),
  seat, bed,
]) + "\n");

const indexPath = `${dir}/index.json`;
const rooms = JSON.parse(readFileSync(indexPath, "utf8"));
const room = rooms.find((entry) => entry.id === id);
if (!room) throw new Error(`Missing room entry: ${id}`);
room.stairs = {
  lowerY: y,
  upperY: loftY,
  points: [[26.2, -145.47], [26.2, -146.48], [23.1, -146.45]],
};
writeFileSync(indexPath, JSON.stringify(rooms));
