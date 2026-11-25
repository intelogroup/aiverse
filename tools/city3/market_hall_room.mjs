// Lay out the Market Hall modules and reuse the credited City 3 crates and plants.
// Usage: bun tools/city3/market_hall_room.mjs /tmp/market-hall-modules.glb
import { readFileSync, writeFileSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, mergeDocuments, prune } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";
import { MARKET_HALL_SAMPLE } from "../../packages/shared/src/marketHall.ts";

const input = process.argv[2];
if (!input) throw new Error("Pass the modules GLB from market_hall_mesh.py");
const assetDir = "apps/console/public/assets";
const id = "hall-0";
const library = "market-hall-interior.glb";
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(input);
const scene = doc.getRoot().listScenes()[0];
const source = await io.read(`${assetDir}/world-city3-library.glb`);
const sourceScene = source.getRoot().listScenes()[0];
const names = new Set(["LIB_wooden_crate_01", "LIB_potted_plant_02"]);
for (const node of sourceScene.listChildren()) {
  if (!names.has(node.getName())) sourceScene.removeChild(node);
}
if (sourceScene.listChildren().length !== names.size) throw new Error("Market Hall stock assets missing from the City 3 library");
source.getRoot().listExtensionsUsed().find(e => e.extensionName === "EXT_meshopt_compression")?.dispose();
await source.transform(prune());
const copied = mergeDocuments(doc, source);
for (const node of sourceScene.listChildren()) scene.addChild(copied.get(node));
copied.get(sourceScene).dispose();
const buffer = doc.getRoot().listBuffers()[0];
for (const accessor of doc.getRoot().listAccessors()) accessor.setBuffer(buffer);
await doc.transform(prune(), dedup());
await io.write(`${assetDir}/interiors/${library}`, doc);

const floorY = 0.20;
const finishY = 0.205;
const items = [
  ["hall_floor", 35, -97.5, 0],
  ["hall_bakery", 24, -88.7, Math.PI / 2, 2.10, 0.5, 2.04],
  ["hall_pantry", 24, -102.6, Math.PI / 2, 2.10, 0.5, 2.04],
  ["hall_produce", 30, -86.6, 0, 1.4, 0.75, 1.08],
  ["hall_produce", 30, -102.3, 0, 1.4, 0.75, 1.08],
  ["hall_produce", 46.5, -103.7, 0, 1.4, 0.75, 1.08],
  ["hall_checkout", 42.8, -83.4, 0, 1.075, 0.45, 1.33],
  ["hall_snack", 42.8, -89.35, Math.PI, 1.8, 0.45, 1.24],
  ["hall_shared_table", 42.5, -96, 0, 1.5, 0.60, 0.78],
  ["hall_bench", 42.5, -94.94, 0, 1.375, 0.18, 0.46],
  ["hall_bench", 42.5, -97.06, 0, 1.375, 0.18, 0.46],
  ["hall_cheese", 22.1, -95.2, Math.PI / 2, 1.75, 0.48, 1.89],
  ["hall_flowers", 50.3, -100.1, -Math.PI / 2, 1.7, 0.56, 1.89],
  ["hall_shelf", 32.2, -93, Math.PI / 2, 1.35, 0.48, 1.56],
  ["hall_shelf", 32.2, -107.2, Math.PI / 2, 1.35, 0.48, 1.56],
  ["hall_shelf", 38.2, -88.1, Math.PI / 2, 1.35, 0.48, 1.56],
  ["hall_shelf", 38.2, -102.9, Math.PI / 2, 1.35, 0.48, 1.56],
  ["hall_water", 49.2, -91.2, -Math.PI / 2, 0.53, 0.34, 1.45],
  ["hall_shared_table", 44.6, -110, 0, 1.5, 0.60, 0.78],
  ["hall_bench", 44.6, -111.06, 0, 1.375, 0.18, 0.46],
  ["wooden_crate_01", 26.8, -89.3, 0],
  ["wooden_crate_01", 26.8, -103.2, Math.PI / 2],
  ["potted_plant_02", 39.8, -94.7, 0],
  ["potted_plant_02", 45.1, -97.3, Math.PI / 2],
];
const frameBays = [-92.7, -98.2, -103.5];
// Measured against the shell. The center-east pendant mounts to a flat beam under the roof.
const sideLights = [
  ...[-85, -99.8, -110].map(z => ["hall_side_pendant", 21.2, 8.0937, z, 0]),
  ...[-85, -110].map(z => ["hall_side_pendant", 48.8, 8.0937, z, Math.PI]),
  ["hall_side_pendant_flat", 48.8, 7.9, -99.8, 0],
];
const props = [
  ...items.map(([name, x, z, yaw]) => [name, x, finishY, z, yaw, 1]),
  ...frameBays.map(z => ["hall_roof_frame", 35, finishY, z, 0, 1]),
  ...sideLights.map(([name, x, y, z, yaw]) => [name, x, y, z, yaw, 1]),
];
const boxes = items.filter(item => item.length > 4).map(([, x, z, yaw, hx, hz, h]) => (
  [x, z, hx, hz, floorY, finishY + h, yaw]
));
for (const z of frameBays) {
  for (const x of [28, 42]) boxes.push([x, z, 0.32, 0.32, floorY, 9.6, 0]);
}
const layout = {
  id, library, props,
  lights: [
    ...frameBays.map(z => [35, 5.68, z, "#ffe6c8", 235, 16]),
    ...sideLights.map(([, x, y, z]) => [x, y - 2.46, z, "#fff1df", 275, 15]),
    [35, 7.35, -83, "#e4ecff", 470, 23],
    ...[33.4, 35, 36.6].map(x => [x, 9.65, -88.2, "#e5efff", 60, 16]),
    [35, 7.35, -110, "#e4ecff", 470, 23],
    [25.5, 4.2, -88, "#ffe9cb", 135, 12],
    [42.5, 4.2, -86, "#fff0d9", 125, 12],
    [44.5, 4.2, -96, "#ffe9cb", 135, 12],
    [25.5, 4.2, -103, "#fff0d9", 130, 12],
    [46.5, 4.2, -106, "#ffe9cb", 120, 12],
  ],
};
const room = {
  id, lot: id, name: "Market Hall", template: "hall", front: "S",
  center: [35, -96], door: [35, -76.9836], rect: [16.75, -118.25, 53.25, -76.984],
  cut: { rect: [16.75, -118.25, 53.25, -76.984], y: 19 },
  layout: `/assets/interiors/${id}.json`, collision: `/assets/interiors/${id}.col.json`, featured: false,
  interactables: [{
    id: MARKET_HALL_SAMPLE.id, room: id, kind: "pickup", asset: "hall_sample",
    label: MARKET_HALL_SAMPLE.name, pos: MARKET_HALL_SAMPLE.position,
    stand: MARKET_HALL_SAMPLE.stand, floorY: MARKET_HALL_SAMPLE.floorY, heading: 0, rotY: Math.PI,
  }],
};
const write = (file, value, indent) => writeFileSync(`${assetDir}/${file}`, JSON.stringify(value, null, indent));
const read = file => JSON.parse(readFileSync(`${assetDir}/${file}`, "utf8"));
function upsert(file, rows, indent) {
  const table = read(file);
  for (const row of rows) {
    const index = table.findIndex(entry => entry.id === row.id);
    if (index === -1) table.push(row);
    else table[index] = row;
  }
  write(file, table, indent);
}
write(`interiors/${id}.json`, layout);
write(`interiors/${id}.col.json`, { id, floorY, boxes, seats: [] });
upsert("interiors/index.json", [room]);
upsert("city3-places.json", [
  { ...read("city3-places.json").find(place => place.id === id), name: "Market Hall", room: id, door: room.door },
  { id: "market-hall-checkout", name: "Market Hall Checkout", kind: "stall", pos: [42.8, -83.4], stand: [42.8, -82.2], heading: Math.PI },
  { id: "market-hall-snacks", name: "Market Hall Snack Counter", kind: "stall", pos: [42.8, -89.35], stand: MARKET_HALL_SAMPLE.stand, heading: 0 },
  { id: "market-hall-bakery", name: "Market Hall Bakery", kind: "stall", pos: [24, -88.7], stand: [25.65, -88.7], heading: -Math.PI / 2 },
  { id: "market-hall-produce", name: "Market Hall Produce", kind: "stall", pos: [30, -86.6], stand: [30, -85.2], heading: Math.PI },
  { id: "market-hall-cheese", name: "Market Hall Cheese Stand", kind: "stall", pos: [22.1, -95.2], stand: [23.5, -95.2], heading: -Math.PI / 2 },
  { id: "market-hall-flowers", name: "Market Hall Flower Stand", kind: "stall", pos: [50.3, -100.1], stand: [48.8, -100.1], heading: Math.PI / 2 },
  { id: "market-hall-pantry-shelves", name: "Market Hall Pantry Shelves", kind: "stall", pos: [38.2, -88.1], stand: [39.35, -88.1], heading: -Math.PI / 2 },
  { id: "market-hall-water", name: "Market Hall Water Station", kind: "stall", pos: [49.2, -91.2], stand: [48.15, -91.2], heading: Math.PI / 2 },
], 1);
upsert("city3-anchors.json", [
  { id: "market-hall-bench-north", building: id, kind: "bench", seat: [42.5, -97.06],
    facing: 0, approach: [42.5, -97.73], approachSide: "back", seatHeight: 0.465, floorY, group: "market-hall-snack-table" },
  { id: "market-hall-bench-south", building: id, kind: "bench", seat: [42.5, -94.94],
    facing: Math.PI, approach: [42.5, -94.27], approachSide: "back", seatHeight: 0.465, floorY, group: "market-hall-snack-table" },
  { id: "market-hall-quiet-bench", building: id, kind: "bench", seat: [44.6, -111.06],
    facing: 0, approach: [44.6, -111.73], approachSide: "back", seatHeight: 0.465, floorY, group: "market-hall-rear-table" },
]);
