/**
 * Prove each rotated house's collision still matches its visual.
 *
 * DistrictWorld rotates the DETAIL by `rotationY` and never touches the collision, because the
 * .col.glb files are baked per lot. That is only correct if a lot's collision really is authored at
 * the lot's angle -- if it were baked at another yaw, the walls would sit across the wrong axis and
 * the walker would stop in mid-air or pass through the house. Nothing in the render path shows
 * that, so compare the two footprints directly:
 *
 *   detail AABB  = bounds(canonical GLB) rotated by rotationY, translated to origin
 *   collision AABB = bounds(col GLB), translated to origin
 *
 * A yaw mismatch on a non-square house moves these by metres; a correct bake leaves them within a
 * metre (the visual includes porch, eaves and roof overhang the solid body does not).
 *
 *   bun tools/city3/verify_collision.mjs
 */
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { readFileSync, existsSync } from "node:fs";

const A = "apps/console/public/assets";
// Negative control: --perturb=90 adds a quarter turn to every lot's detail before comparing, which
// MUST be reported as swapped axes. Run it once to prove this check is not vacuous.
const PERTURB = Number((process.argv.find((a) => a.startsWith("--perturb=")) ?? "--perturb=0").split("=")[1]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
await MeshoptDecoder.ready;

const man = JSON.parse(readFileSync(`${A}/districts.json`, "utf8"));
const rotY = (v, deg) => {
  const r = (deg * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};
const rotBounds = (b, deg) => {
  const pts = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(rotY([x, y, z], deg));
  return { min: [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]))), max: [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]))) };
};
const path = (u) => `${A}/${u.replace(/^\/assets\//, "")}`;

const lots = man.districts.filter((d) => d.id.startsWith("house-") && d.collisionUrl);
let checked = 0, rotated = 0, worstRotated = 0, worstExcess = 0;
const rotatedFail = [];
for (const d of lots) {
  if (!existsSync(path(d.url)) || !existsSync(path(d.collisionUrl))) {
    console.log(`  SKIP ${d.id}: missing file`); continue;
  }
  const deg = d.rotationY ?? 0;
  const detail = rotBounds(getBounds((await io.read(path(d.url))).getRoot().listScenes()[0]), deg + PERTURB);
  const col = getBounds((await io.read(path(d.collisionUrl))).getRoot().listScenes()[0]);
  const fx = detail.max[0] - detail.min[0], fz = detail.max[2] - detail.min[2];
  const cx = col.max[0] - col.min[0], cz = col.max[2] - col.min[2];
  const delta = Math.max(Math.abs(fx - cx), Math.abs(fz - cz));
  // a collision body may be INTENTIONALLY inset (houses.sh --body= excludes pool decks, terraces,
  // porches: cabin-1 is 14.3x7.1 of solid inside a 17.5x10.9 footprint). It must never exceed the
  // visual, though -- that would put walls out in the street.
  const excess = Math.max(cx - fx, cz - fz);
  // A yaw error of 90/270 SWAPS the footprint axes, while an inset only shrinks it. So for a
  // non-square house the unswapped pairing must fit better; if the swapped one does, the collision
  // was authored at a different quarter-turn than the detail is rendered at.
  const nonSquare = Math.abs(fx - fz) > 1;
  const fitStraight = Math.abs(fx - cx) + Math.abs(fz - cz);
  const fitSwapped = Math.abs(fx - cz) + Math.abs(fz - cx);
  const swapped = nonSquare && fitSwapped + 1 < fitStraight;
  checked++;
  worstExcess = Math.max(worstExcess, excess);
  if (deg) {
    rotated++;
    worstRotated = Math.max(worstRotated, delta);
    if (swapped) { rotatedFail.push(`${d.id} (rot ${deg}: collision fits as ${cz.toFixed(1)}x${cx.toFixed(1)} -- axes swapped)`); }
    if (swapped) console.log(`  ${d.id.padEnd(22)} rot ${String(deg).padStart(3)}  detail ${fx.toFixed(1)}x${fz.toFixed(1)}  col ${cx.toFixed(1)}x${cz.toFixed(1)}  AXES SWAPPED`);
  }
}
console.log(`\n${checked} lots checked, ${rotated} rotated`);
console.log(`  rotated lots with swapped axes (a 90/270 yaw error): ${rotatedFail.length} -- must be 0`);
console.log(`  worst rotated detail-vs-collision footprint delta ${worstRotated.toFixed(2)} m (inset is expected where houses.sh passes --body=)`);
console.log(`  worst collision EXCESS over the visual ${worstExcess.toFixed(2)} m -- must be < 0.5 (no walls in the street)`);
if (rotatedFail.length || worstExcess > 0.5) {
  if (rotatedFail.length) console.error(`FAIL: ${rotatedFail.length} rotated lot(s) with a mismatched collision: ${rotatedFail.join(", ")}`);
  if (worstExcess > 0.5) console.error("FAIL: a collision body is larger than its visual");
  process.exit(1);
}
console.log("PASS: no rotated lot has swapped collision axes, and no collision exceeds its visual");

