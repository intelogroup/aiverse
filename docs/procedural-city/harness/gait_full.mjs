// Full-stack gait check (2026-11-07): replicates CastFigure's gait path on the shipped GLBs, importing the shipped
// grounding.ts / gait.ts, and measures what a viewer sees:
//   SKATE: mean / worst horizontal speed of skinned foot vertices touching the floor (< 1 cm in consecutive
//          frames) and the share of frames with any contact (a walk must be ~100 %).
//   SOLE:  lowest skinned vertex height over the cycle (air-walk > 0, sink < 0).
// MODE=before replays the pre-fix path (unscaled root-motion cancel, hips guard band 0.09 + Run footLift);
// default = the shipped path (scaled cancel + foot grounding). FLOOR overrides the Walk rate floor, VS the speeds.
// Copy into apps/console/ (bare `three` resolves there) and run: node --experimental-strip-types gait_full.mjs summer|remy
// (needs node >= 22.6 for TypeScript imports).
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { contactPoints, soleClearance, clipMinClearance, groundingOffset, rootMotionDelta } from "./src/features/world/grounding.ts";
import { MIN_WALK_RATE } from "./src/features/world/gait.ts";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
const BODIES = {
  summer: { url: "public/assets/cast-summer.glb", walkSpeed: 1.107, run: { speed: 2.7755, footLift: 0.0967, phaseOffset: -0.083 } },
  remy: { url: "public/assets/cast-remy.glb", walkSpeed: 0.77, run: { speed: 2.66, footLift: 0.082, phaseOffset: -0.055 } },
};
const sm = (lo, hi, x) => { const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function strip(buf) {
  const jl = buf.readUInt32LE(12); const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  delete json.images; delete json.textures; delete json.samplers;
  if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter((e) => !/texture|basisu|webp/i.test(e));
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter((e) => !/texture|basisu|webp/i.test(e));
  const kill = (o) => { if (o && typeof o === "object") for (const k of Object.keys(o)) { if (/Texture$/.test(k)) delete o[k]; else kill(o[k]); } };
  kill(json.materials);
  let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(" ")]);
  const rest = buf.subarray(20 + jl); const out = Buffer.alloc(20 + js.length + rest.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20); rest.copy(out, 20 + js.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}
const which = process.argv[2] ?? "summer"; const B = BODIES[which];
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(strip(fs.readFileSync(B.url)), "", res, rej));
const clip = (n) => gltf.animations.find((a) => a.name === n);
const SPEC = { walkSpeed: B.walkSpeed, runSpeed: B.run.speed, walkDuration: clip("Walk").duration, runDuration: clip("Run").duration };
const FLOOR = Number(process.env.FLOOR ?? MIN_WALK_RATE);
const rateFor = (s, r) => { const ws = SPEC.walkSpeed * SPEC.walkDuration, rs = SPEC.runSpeed * SPEC.runDuration; return clamp(s / (ws + (rs - ws) * clamp(r, 0, 1)), FLOOR / SPEC.walkDuration, 1.5 / SPEC.runDuration); };
const AFTER = (process.env.MODE ?? "after") !== "before";
 // full = CastFigure stack; raw = no hips guard, no footLift

function sim(v, { reverse = false, turnR = 0, secs = 5, dt = 1 / 60 } = {}) {
  const scene = SkeletonUtils.clone(gltf.scene);
  scene.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(scene); const lift = -box.min.y;
  const grp = new THREE.Group(); grp.add(scene); scene.position.y = lift; grp.updateMatrixWorld(true);
  let hips = null; scene.traverse((o) => { if (!hips && o.name.endsWith("Hips")) hips = o; });
  const parent = hips.parent, hipsRest = hips.position.clone(), parentRest = parent.position.clone(), pq = parent.quaternion.clone();
  const rw = new THREE.Vector3(); hips.getWorldPosition(rw); const restHipsY = rw.y;
  const pts = contactPoints(scene); const runMin = clipMinClearance(scene, clip("Run"), pts);
  const mixer = new THREE.AnimationMixer(scene);
  const walk = mixer.clipAction(clip("Walk")), run = mixer.clipAction(clip("Run")), idle = mixer.clipAction(clip(process.env.IDLE ?? "IdleLong"));
  for (const a of [walk, run, idle]) { a.play(); a.setEffectiveWeight(0); }
  const skins = []; scene.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });
  const footV = skins.map((m) => { const idx = []; const v = new THREE.Vector3(); const n = m.geometry.attributes.position.count; for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); m.localToWorld(v); if (v.y < 0.14) idx.push(i); } return idx; });
  const skate = () => { const v = new THREE.Vector3(); const o = []; skins.forEach((m, k) => { for (const i of footV[k]) { m.getVertexPosition(i, v); m.localToWorld(v); o.push(v.x, v.y, v.z); } }); return o; };
  const sole = () => { const o = skate(); let lo = 1e9; for (let j = 1; j < o.length; j += 3) if (o[j] < lo) lo = o[j]; return lo; };
  const feet = []; scene.traverse((o) => { if (/(Left|Right)(Foot|ToeBase)$/.test(o.name)) feet.push(o); });
  // standing reference: Idle pose joint heights
  idle.setEffectiveWeight(1); mixer.update(0); grp.updateMatrixWorld(true);
  const restY = feet.map((f) => f.getWorldPosition(new THREE.Vector3()).y); idle.setEffectiveWeight(0);
  const g = sm(SPEC.walkSpeed * 1.25, SPEC.runSpeed * 0.85, v), rm = reverse ? 0 : g, moving = sm(0.08, 0.35, v);
  const rate = rateFor(v, rm);
  walk.timeScale = rate * SPEC.walkDuration * (reverse ? -1 : 1); run.timeScale = rate * SPEC.runDuration;
  walk.setEffectiveWeight(moving * (1 - rm)); run.setEffectiveWeight(moving * rm); idle.setEffectiveWeight(1 - moving);
  const rec = []; let x = 0, z = 0, head = 0, ang = 0; const d = new THREE.Vector3(), hw = new THREE.Vector3();
  for (let t = 0; t < secs; t += dt) {
    run.time = ((((walk.time / SPEC.walkDuration + B.run.phaseOffset) % 1) + 1) % 1) * SPEC.runDuration;
    mixer.update(dt);
    if (turnR) { ang += (v / turnR) * dt; x = turnR * (1 - Math.cos(ang)); z = turnR * Math.sin(ang); head = ang; }
    else z += (reverse ? -v : v) * dt;
    if (AFTER) rootMotionDelta(hips.position, hipsRest, parent.scale, pq, d); else { d.copy(hips.position).sub(hipsRest).applyQuaternion(pq); } d.y = 0; parent.position.copy(parentRest).sub(d);
    grp.position.set(x, 0, z); grp.rotation.y = head; grp.updateMatrixWorld(true);
    if (AFTER) {
      grp.position.y = -groundingOffset(soleClearance(pts, scene), runMin, moving * rm); grp.updateMatrixWorld(true);
    } else {
      hips.getWorldPosition(hw); const dy = grp.worldToLocal(hw).y - restHipsY;
      grp.position.y = -(dy - clamp(dy, -0.09, 0.09)) - B.run.footLift * moving * rm; grp.updateMatrixWorld(true);
    }
    rec.push({ p: feet.map((b) => b.getWorldPosition(new THREE.Vector3())), gy: grp.position.y, sole: (Math.round(t / dt) % 3 === 0) ? sole() : null, sk: skate() });
  }
  const skip = Math.round(1 / dt); const out = [];
  for (let k = 0; k < feet.length; k++) {
    const ys = rec.slice(skip).map((r) => r.p[k].y); const ymin = Math.min(...ys); let s = 0, n = 0;
    for (let i = skip + 1; i < rec.length; i++) { const a = rec[i].p[k], b = rec[i - 1].p[k];
      if (a.y < ymin + 0.02 && b.y < ymin + 0.02) { s += Math.hypot(a.x - b.x, a.z - b.z) / dt; n++; } }
    out.push(`${feet[k].name.replace(/mixamorig:?/, "").padEnd(13)} slip ${(s / n).toFixed(3)} m/s  lowest ${(ymin - restY[k] >= 0 ? "+" : "") + (ymin - restY[k]).toFixed(3)} m vs standing`);
  }
  const gys = rec.slice(skip).map((r) => r.gy); const so = rec.slice(skip).map((r) => r.sole).filter((x) => x !== null);
  let ss = 0, sn = 0, smax = 0; for (let i = skip + 1; i < rec.length; i++) { const a = rec[i].sk, b = rec[i - 1].sk; let fs = 0, fn = 0; for (let j = 0; j < a.length; j += 3) if (a[j + 1] < 0.01 && b[j + 1] < 0.01) { fs += Math.hypot(a[j] - b[j], a[j + 2] - b[j + 2]) / dt; fn++; } if (fn) { const f = fs / fn; ss += f; sn++; smax = Math.max(smax, f); } }
  out.length = 0; out.push(`SKATE (verts on floor <1cm): mean ${(ss / Math.max(1, sn)).toFixed(3)} m/s, worst frame ${smax.toFixed(3)} m/s, frames w/ contact ${(100 * sn / (rec.length - skip - 1)).toFixed(0)}%`);
  const air = so.filter((y) => y > 0.02).length / so.length, sink = so.filter((y) => y < -0.02).length / so.length;
  out.push(`SOLE lowest vertex: min ${Math.min(...so).toFixed(3)} max ${Math.max(...so).toFixed(3)} m | airborne(>2cm) ${(air*100).toFixed(0)}% | sunk(<-2cm) ${(sink*100).toFixed(0)}%`);
  console.log(`${which} v=${v}${reverse ? " BACK" : ""}${turnR ? ` circle r=${turnR}` : ""} runMix=${rm.toFixed(2)} walkTS=${walk.timeScale.toFixed(2)} figure y ${Math.min(...gys).toFixed(3)}..${Math.max(...gys).toFixed(3)}\n   ` + out.join("\n   "));
}
console.log(`${AFTER ? "AFTER (shipped)" : "BEFORE"} FLOOR=${FLOOR} walk ${SPEC.walkDuration.toFixed(3)}s run ${SPEC.runDuration.toFixed(3)}s`);
const VS = (process.env.VS ?? '0.3,0.7,1.3,1.9,2.7').split(',').map(Number); for (const v of VS) sim(v);
if (!process.env.VS) { sim(1.3, { reverse: true }); sim(1.3, { turnR: 1.5 }); }
