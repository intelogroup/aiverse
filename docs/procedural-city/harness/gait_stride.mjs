// Measure Summer's Walk/Run stance-foot ground speed (and vertical hips drift) in three space, as CastFigure sees it.
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const path = process.argv[2];
const buf = fs.readFileSync(path);
const jl = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
delete json.images; delete json.textures; delete json.samplers;
for (const m of json.materials ?? []) {
  const p = m.pbrMetallicRoughness; if (p) { delete p.baseColorTexture; delete p.metallicRoughnessTexture; }
  delete m.normalTexture; delete m.emissiveTexture; delete m.occlusionTexture;
}
let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(" ")]);
const rest = buf.subarray(20 + jl);
const out = Buffer.alloc(20 + js.length + rest.length);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20); rest.copy(out, 20 + js.length);
const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);

const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
const scene = gltf.scene;
const find = (n) => { let r = null; scene.traverse((o) => { if (!r && o.name.replace(/[:.]/g, "") === n.replace(/[:.]/g, "")) r = o; }); return r; };
const hips = find("mixamorig:Hips");
const parent = hips.parent;
const hipsRest = hips.position.clone(); const parentRest = parent.position.clone(); const parentQuat = parent.quaternion.clone();
scene.updateMatrixWorld(true);
const restHips = new THREE.Vector3(); hips.getWorldPosition(restHips);
const feet = { L: find("mixamorig:LeftFoot"), R: find("mixamorig:RightFoot"), LT: find("mixamorig:LeftToeBase"), RT: find("mixamorig:RightToeBase") };
const mixer = new THREE.AnimationMixer(scene);
const BAND = Number(process.argv[3] ?? 0.015);

function measure(name, N = 240) {
  const clip = gltf.animations.find((a) => a.name === name);
  mixer.stopAllAction();
  const a = mixer.clipAction(clip); a.reset().play(); a.setEffectiveWeight(1);
  const D = clip.duration; const samples = [];
  for (let i = 0; i <= N; i++) {
    a.time = (i / N) * D; mixer.update(0);
    const d = hips.position.clone().sub(hipsRest).applyQuaternion(parentQuat); d.y = 0;
    parent.position.copy(parentRest).sub(d);
    scene.updateMatrixWorld(true);
    const s = { t: (i / N) * D };
    for (const [k, b] of Object.entries(feet)) s[k] = b.getWorldPosition(new THREE.Vector3());
    s.hips = hips.getWorldPosition(new THREE.Vector3());
    samples.push(s);
  }
  const res = { name, duration: D };
  for (const k of ["LT", "RT", "L", "R"]) {
    const ys = samples.map((s) => s[k].y); const ymin = Math.min(...ys);
    let sum = 0, n = 0, st = 0;
    for (let i = 1; i < samples.length; i++) {
      const p = samples[i - 1], q = samples[i];
      if (q[k].y < ymin + BAND) st++;
      if (p[k].y < ymin + BAND && q[k].y < ymin + BAND) { sum += -(q[k].z - p[k].z) / (q.t - p.t); n++; }
    }
    const td = [];
    for (let i = 1; i < samples.length; i++) if (ys[i] < ymin + BAND && ys[i - 1] >= ymin + BAND) td.push(+(samples[i].t / D).toFixed(3));
    res[k] = { stanceSpeed: +(sum / n).toFixed(4), stanceFrac: +(st / samples.length).toFixed(2), ymin: +ymin.toFixed(4), ymax: +Math.max(...ys).toFixed(3),
      zRange: [+Math.min(...samples.map((s) => s[k].z)).toFixed(3), +Math.max(...samples.map((s) => s[k].z)).toFixed(3)],
      xMean: +(samples.reduce((acc, s) => acc + s[k].x, 0) / samples.length).toFixed(3), touchdownPhase: td };
  }
  const hy = samples.map((s) => s.hips.y - restHips.y);
  res.hipsDy = { min: +Math.min(...hy).toFixed(3), max: +Math.max(...hy).toFixed(3), start: +hy[0].toFixed(3), end: +hy[hy.length - 1].toFixed(3) };
  const hx = samples.map((s) => s.hips.x), hz = samples.map((s) => s.hips.z);
  res.hipsXZAfterCancel = { x: [+Math.min(...hx).toFixed(3), +Math.max(...hx).toFixed(3)], z: [+Math.min(...hz).toFixed(3), +Math.max(...hz).toFixed(3)] };
  const raw = clip.tracks.find((t) => t.name.endsWith("Hips.position"));
  if (raw) { const v = raw.values; res.rawHipsFirstLast = [[v[0], v[1], v[2]].map((x) => +x.toFixed(3)), [v[v.length - 3], v[v.length - 2], v[v.length - 1]].map((x) => +x.toFixed(3))]; }
  res.t0 = { LTz: +samples[0].LT.z.toFixed(3), RTz: +samples[0].RT.z.toFixed(3), LTy: +samples[0].LT.y.toFixed(3), RTy: +samples[0].RT.y.toFixed(3) };
  if (process.env.DUMP === name) for (const s of samples.filter((_, i) => i % 8 === 0)) console.log(`${(s.t / D).toFixed(3)} LT y=${s.LT.y.toFixed(3)} z=${s.LT.z.toFixed(3)}  RT y=${s.RT.y.toFixed(3)} z=${s.RT.z.toFixed(3)}  hipsY=${(s.hips.y - restHips.y).toFixed(3)}`);
  return res;
}
for (const n of ["Walk", "Run"]) console.log(JSON.stringify(measure(n)));
