// Foot-slip check of the gait blend exactly as CastFigure applies it: figure translated at ground speed v
// (forward or backward), Walk/Run weights + shared phase from gait.ts; measure world-space speed of the lowest
// foot joint while it is within 2 cm of the lowest height seen (the planted foot). 0 = no skate.
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const smooth = (lo, hi, x) => { const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
const SPEC = { walkSpeed: 1.0796, runSpeed: 2.673, walkDuration: 1.1666666, runDuration: 0.7333333 };
const RUN = { footLift: 0.088, phaseOffset: -0.067 };
const cycleRateFor = (s, r) => { const ws = SPEC.walkSpeed * SPEC.walkDuration, rs = SPEC.runSpeed * SPEC.runDuration; return Math.max(0.6 / SPEC.walkDuration, Math.min(1.5 / SPEC.runDuration, s / (ws + (rs - ws) * r))); };

const buf = fs.readFileSync("public/assets/cast-summer.glb");
const jl = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
delete json.images; delete json.textures; delete json.samplers;
for (const m of json.materials ?? []) { const p = m.pbrMetallicRoughness; if (p) { delete p.baseColorTexture; delete p.metallicRoughnessTexture; } delete m.normalTexture; delete m.emissiveTexture; delete m.occlusionTexture; }
let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(" ")]);
const rest = buf.subarray(20 + jl); const out = Buffer.alloc(20 + js.length + rest.length);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20); rest.copy(out, 20 + js.length);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(out.buffer.slice(out.byteOffset, out.byteOffset + out.length), "", res, rej));

function sim(v, reverse, secs = 4, dt = 1 / 30) {
  const scene = gltf.scene.clone(true);
  const grp = new THREE.Group(); grp.add(scene);
  const mixer = new THREE.AnimationMixer(scene);
  const clip = (n) => gltf.animations.find((a) => a.name === n);
  const walk = mixer.clipAction(clip("Walk")), run = mixer.clipAction(clip("Run")), idle = mixer.clipAction(clip("Idle"));
  for (const a of [walk, run, idle]) { a.play(); a.setEffectiveWeight(0); }
  const feet = []; scene.traverse((o) => { if (/(Left|Right)(Foot|ToeBase)$/.test(o.name)) feet.push(o); });
  const lo = SPEC.walkSpeed * 1.25, hi = SPEC.runSpeed * 0.85;
  const g = smooth(lo, hi, v); const rm = reverse ? 0 : g;
  const rate = cycleRateFor(v, rm);
  walk.timeScale = rate * SPEC.walkDuration * (reverse ? -1 : 1);
  run.timeScale = rate * SPEC.runDuration;
  walk.setEffectiveWeight(1 - rm); run.setEffectiveWeight(rm);
  const rec = []; let z = 0;
  for (let t = 0; t < secs; t += dt) {
    const wp = walk.time / SPEC.walkDuration;
    run.time = ((((wp + RUN.phaseOffset) % 1) + 1) % 1) * SPEC.runDuration;
    mixer.update(dt);
    z += (reverse ? -v : v) * dt;
    grp.position.set(0, -RUN.footLift * rm, z);
    grp.updateMatrixWorld(true);
    rec.push(feet.map((b) => b.getWorldPosition(new THREE.Vector3())));
  }
  const res = [];
  for (let k = 0; k < feet.length; k++) {
    const ys = rec.map((r) => r[k].y); const ymin = Math.min(...ys.slice(10));
    let sum = 0, n = 0;
    for (let i = 11; i < rec.length; i++) if (ys[i] < ymin + 0.02 && ys[i - 1] < ymin + 0.02) { sum += Math.abs(rec[i][k].z - rec[i - 1][k].z) / dt; n++; }
    res.push(`${feet[k].name.replace("mixamorig", "")} slip ${(sum / n).toFixed(3)} m/s ymin ${ymin.toFixed(3)}`);
  }
  console.log(`v=${v} ${reverse ? "BACK" : "fwd "} runMix=${rm.toFixed(2)} rate=${rate.toFixed(3)} walkTS=${walk.timeScale.toFixed(3)} runTS=${run.timeScale.toFixed(3)}\n   ` + res.join("\n   "));
}
for (const [v, r] of (process.env.FLOOR ? [[1.0796, false], [2.673, false], [2.5, false], [2.9, false]] : [[1.3, false], [1.9, false], [2.7, false], [1.3, true]])) sim(v, r);
// Reference: the OLD path at run speed (Walk timeScale capped 1.4, no Run).
{
  const v = 2.7; const scene = gltf.scene.clone(true); const grp = new THREE.Group(); grp.add(scene);
  const mixer = new THREE.AnimationMixer(scene); const walk = mixer.clipAction(gltf.animations.find((a) => a.name === "Walk")); walk.play(); walk.timeScale = 1.4;
  const feet = []; scene.traverse((o) => { if (/(Left|Right)ToeBase$/.test(o.name)) feet.push(o); });
  const rec = []; let z = 0; const dt = 1 / 30;
  for (let t = 0; t < 4; t += dt) { mixer.update(dt); z += v * dt; grp.position.z = z; grp.updateMatrixWorld(true); rec.push(feet.map((b) => b.getWorldPosition(new THREE.Vector3()))); }
  const ys = rec.map((r) => r[0].y); const ymin = Math.min(...ys); let s = 0, n = 0;
  for (let i = 1; i < rec.length; i++) if (ys[i] < ymin + 0.02 && ys[i - 1] < ymin + 0.02) { s += Math.abs(rec[i][0].z - rec[i - 1][0].z) / dt; n++; }
  console.log(`OLD path v=2.7 Walk x1.4: LeftToeBase slip ${(s / n).toFixed(3)} m/s`);
}
