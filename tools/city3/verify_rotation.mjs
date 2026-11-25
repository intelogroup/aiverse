/** Verify a runtime yaw equals the baked one: world bounds of (canonical GLB rotated by rotationY)
 *  vs the deleted per-yaw GLB, straight out of git. */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/core";
import { MeshoptDecoder } from "meshoptimizer";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";

const A = "apps/console/public/assets/houses";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
await MeshoptDecoder.ready;

const man = JSON.parse(readFileSync("apps/console/public/assets/districts.json", "utf8"));
const re = /^(.*)-y(0|90|180|270)\.glb$/;
const CASES = [];
for (const d of man.districts) {
  if (d.id.startsWith("house-") && d.rotationY) {
    const m = re.exec(d.url.split("/").pop());
    if (!m) continue;
    const canon = Number(m[2]), baked = (canon + d.rotationY) % 360;
    if (!CASES.some((c) => c[0] === m[1])) CASES.push([m[1], canon, baked, d.rotationY]);
  }
}
if (!CASES.length) { console.error("no rotationY districts found"); process.exit(1); }

const fromGit = async (name) => {
  // Baseline is origin/main, not HEAD: HEAD already contains the collapse commit, so the
  // per-yaw bakes this compares against no longer exist there.
  const p = `/tmp/_orig_${name}`;
  writeFileSync(p, execFileSync("git", ["show", `origin/main:${A}/${name}`], { maxBuffer: 1 << 28 }));
  const d = await io.read(p); unlinkSync(p); return d;
};

/** Rotate a point about Y by deg (multiples of 90 rotate an AABB exactly, no sampling needed). */
const rotY = (v, deg) => {
  const r = (deg * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};
const rotBounds = (b, deg) => {
  const pts = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(rotY([x, y, z], deg));
  return { min: [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]))), max: [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]))) };
};

for (const [model, canon, baked, deg] of CASES.slice(0, 5)) {
  const runtime = await io.read(`${A}/${model}-y${canon}.glb`);
  const orig = await fromGit(`${model}-y${baked}.glb`);
  // the canonical model is authored at yaw 0, so rotating its bounds by `deg` must land on the
  // bounds of the file that had that yaw baked into its vertices
  const b1 = rotBounds(getBounds(runtime.getRoot().listScenes()[0]), deg);
  const b2 = getBounds(orig.getRoot().listScenes()[0]);
  const diff = Math.max(...b1.min.map((v, i) => Math.abs(v - b2.min[i])), ...b1.max.map((v, i) => Math.abs(v - b2.max[i])));
  // Against origin/main the delta is sub-millimetre rather than 0: this branch ships meshopt-
  // compressed houses (KHR_mesh_quantization, 14-bit positions), so the baseline's vertices sit
  // up to extent/2^14 (~1 mm on a 20 m house) from the quantised ones. A wrong yaw would be
  // measured in metres, so 20 mm is a generous threshold, not a tight one.
  console.log(`${model.padEnd(16)} y${canon}+${deg} vs baked y${baked}: max bound delta ${diff.toFixed(4)} m ${diff < 0.02 ? "OK" : "MISMATCH"}`);
}
