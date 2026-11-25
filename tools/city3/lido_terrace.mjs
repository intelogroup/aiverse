// Place the locally authored terrace on the Lido's tiled deck.
// Usage: bun tools/city3/lido_terrace.mjs <lido_terrace_mesh.py output directory>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { placeProps } from "./place_props.mjs";

const modules = process.argv[2];
if (!modules) throw new Error("Pass the Lido terrace modules directory");

const id = "lido-terrace";
const center = [35, 115.1];
const deckY = 0.28;
const floorY = 0.20; // Existing outdoor walk surface, 8 cm below the visual deck finish.
const benchZ = 116;
const benches = [33.25, 36.75];
const posts = [31.35, 38.65].flatMap(x => [113.3, 116.9].map(z => [x, z, 0]));
const prop = (name, col, at, y) => ({ name, src: join(modules, `${name}.glb`), col, at, y });

await placeProps({
  id, name: "Lido terrace", center, half: 6, y: deckY,
  props: [
    prop("canopy", null, [[...center, 0]], deckY + 2.60),
    prop("post", [0.12, 0.12, 2.60], posts),
    prop("bench", [1.12, 0.29, 0.88], benches.map(x => [x, benchZ, 0])),
    prop("planter", [0.6, 0.30, 0.40], [30.3, 39.7].map(x => [x, 116.9, 0])),
  ],
});

function upsert(file, rows, indent) {
  const path = `apps/console/public/assets/${file}`;
  const table = JSON.parse(readFileSync(path, "utf8"));
  const ids = new Set(rows.map(row => row.id));
  writeFileSync(path, JSON.stringify([...table.filter(row => !ids.has(row.id)), ...rows], null, indent));
}

upsert("city3-places.json", [{
  id, name: "Lido Terrace", kind: "landmark", pos: center, stand: [35, 113.9], heading: 0,
}], 1);

upsert("city3-anchors.json", benches.map((x, index) => ({
  id: index === 0 ? "lido-bench-west" : "lido-bench-east",
  building: id, kind: "bench", seat: [x, benchZ], facing: Math.PI,
  approach: [x, benchZ - 1], approachSide: "front",
  seatHeight: deckY + 0.46 - floorY, floorY, group: id,
})));
