// Copy into apps/console/ and run: node --experimental-strip-types contact_probe.mjs bodyblock,summer,remy contact.csv  (needs node >= 22.6)
// Contact-pose probe: for each body/clip, the rolling contact point of each foot (lowest skinned foot vertex, after the
// pelvis offset the viewer sees) in the in-place body frame. A planted foot must move backwards at constant speed v:
// zc(t) + v*t flat. CSV out: body,clip,foot,phase,contact,zc,yc,ankleY,ankleZ,pitchDeg
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { rootMotionDelta } from "./src/features/world/grounding.ts";
function strip(buf) {
  const jl = buf.readUInt32LE(12); const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  delete json.images; delete json.textures; delete json.samplers;
  for (const k of ["extensionsUsed", "extensionsRequired"]) if (json[k]) json[k] = json[k].filter((e) => !/texture|basisu|webp/i.test(e));
  const kill = (o) => { if (o && typeof o === "object") for (const k of Object.keys(o)) { if (/Texture$/.test(k)) delete o[k]; else kill(o[k]); } }; kill(json.materials);
  let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(" ")]);
  const rest = buf.subarray(20 + jl); const out = Buffer.alloc(20 + js.length + rest.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20); rest.copy(out, 20 + js.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}
const rows = ["body,clip,foot,phase,contact,zc,yc,ankleY,ankleZ,pitchDeg"]; const N = 120;
const summary = [];
for (const body of (process.argv[2] ?? "bodyblock,summer,remy").split(",")) {
  const gltf = await new Promise((r, j) => new GLTFLoader().parse(strip(fs.readFileSync(`public/assets/cast-${body}.glb`)), "", r, j));
  { // rig facts in the bind pose
    const sc = SkeletonUtils.clone(gltf.scene); sc.updateMatrixWorld(true); const W = (n) => { let r; sc.traverse((o) => { if (!r && o.name.replace(/mixamorig[:_]?/, "") === n) r = o; }); return r.getWorldPosition(new THREE.Vector3()); };
    const h = W("Hips"), k = W("LeftLeg"), an = W("LeftFoot"), tb = W("LeftToeBase"), te = W("LeftToe_End"), up = W("LeftUpLeg"); const m = new THREE.Box3().setFromObject(sc);
    console.log(`RIG ${body.padEnd(9)} height ${(m.max.y - m.min.y).toFixed(2)} m | hips y ${(h.y - m.min.y).toFixed(3)} | thigh ${up.distanceTo(k).toFixed(3)} shin ${k.distanceTo(an).toFixed(3)} (leg ${(up.distanceTo(k) + k.distanceTo(an)).toFixed(3)}) | ankle y ${(an.y - m.min.y).toFixed(3)} | ankle->toebase ${an.distanceTo(tb).toFixed(3)} toebase->toe_end ${tb.distanceTo(te).toFixed(3)} | toe_end y ${(te.y - m.min.y).toFixed(3)} z ${(te.z - an.z).toFixed(3)} | leg/height ${((up.distanceTo(k) + k.distanceTo(an)) / (m.max.y - m.min.y)).toFixed(3)}`);
  }
  for (const clipName of ["Walk", "Run"]) {
    const clip = gltf.animations.find((a) => a.name === clipName);
    const scene = SkeletonUtils.clone(gltf.scene); scene.updateMatrixWorld(true);
    const lift = -new THREE.Box3().setFromObject(scene).min.y; const grp = new THREE.Group(); grp.add(scene); scene.position.y = lift; grp.updateMatrixWorld(true);
    let hips; scene.traverse((o) => { if (!hips && o.name.endsWith("Hips")) hips = o; });
    const parent = hips.parent, hipsRest = hips.position.clone(), parentRest = parent.position.clone(), pq = parent.quaternion.clone();
    const bone = (n) => { let r; scene.traverse((o) => { if (!r && o.name.replace(/mixamorig[:_]?/, "") === n) r = o; }); return r; };
    const side = (s) => ({ ankle: bone(`${s}Foot`), toeB: bone(`${s}ToeBase`), toeE: bone(`${s}Toe_End`) });
    const feet = { L: side("Left"), R: side("Right") };
    const skins = []; scene.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });
    const tmp = new THREE.Vector3();
    // foot vertices: bind height < 0.12; group by the sign of x relative to the Left foot bone's bind x
    const lx = feet.L.ankle.getWorldPosition(new THREE.Vector3()).x;
    const groups = { L: [], R: [] };
    skins.forEach((m, k) => { const c = m.geometry.attributes.position.count; for (let i = 0; i < c; i++) { m.getVertexPosition(i, tmp); m.localToWorld(tmp); if (tmp.y - 0 < 0.12 + 0 && Math.abs(tmp.x) > 0.01) groups[(tmp.x - 0) * lx > 0 ? "L" : "R"].push([k, i]); } });
    const mixer = new THREE.AnimationMixer(scene); const a = mixer.clipAction(clip); a.play();
    const bind = {}; for (const f of ["L", "R"]) { const A = feet[f].ankle.getWorldPosition(new THREE.Vector3()), T = feet[f].toeE.getWorldPosition(new THREE.Vector3()); bind[f] = Math.atan2(T.y - A.y, T.z - A.z); }
    const samples = [];
    for (let s = 0; s < N; s++) {
      a.time = (s / N) * clip.duration; mixer.update(0);
      rootMotionDelta(hips.position, hipsRest, parent.scale, pq, tmp); parent.position.copy(parentRest).sub(tmp); grp.updateMatrixWorld(true);
      const rec = {};
      for (const f of ["L", "R"]) {
        let ymin = 1e9, zc = 0; const v = new THREE.Vector3();
        for (const [k, i] of groups[f]) { skins[k].getVertexPosition(i, v); skins[k].localToWorld(v); if (v.y < ymin) { ymin = v.y; zc = v.z; } }
        const A = feet[f].ankle.getWorldPosition(new THREE.Vector3()), T = feet[f].toeE.getWorldPosition(new THREE.Vector3());
        rec[f] = { ymin, zc, ay: A.y, az: A.z, pitch: ((Math.atan2(T.y - A.y, T.z - A.z) - bind[f]) * 180) / Math.PI };
      }
      samples.push(rec);
    }
    const dt = clip.duration / N;
    const live = samples.map((r) => Math.min(r.L.ymin, r.R.ymin)); // pelvis offset the walker applies (Walk)
    const fixed = Math.min(...live); // one offset for the whole cycle (what Run uses, via runMin)
    for (const f of ["L", "R"]) {
      for (const [mode, off] of [["live", (i) => live[i]], ["fixed", () => fixed]]) {
        const c = samples.map((r, i) => r[f].ymin - off(i) < 0.015);
        if (mode === "fixed") samples.forEach((r, i) => rows.push([body, clipName, f, (i / N).toFixed(4), c[i] ? 1 : 0, r[f].zc.toFixed(4), (r[f].ymin - fixed).toFixed(4), (r[f].ay - fixed).toFixed(4), r[f].az.toFixed(4), r[f].pitch.toFixed(1)].join(",")));
        // longest circular contact run
        let best = null; for (let st = 0; st < N; st++) { if (!(c[st] && !c[(st + N - 1) % N])) continue; const run = []; for (let k = 0; k < N && c[(st + k) % N]; k++) run.push((st + k) % N); if (!best || run.length > best.length) best = run; }
        if (!best) { summary.push(`${body.padEnd(9)} ${clipName.padEnd(4)} ${f} ${mode.padEnd(5)}: no contact`); continue; }
        const n = best.length, ts = best.map((_, k) => k * dt), zs = best.map((i) => samples[i][f].zc);
        const mt = ts.reduce((p, q) => p + q, 0) / n, mz = zs.reduce((p, q) => p + q, 0) / n;
        const slope = ts.reduce((p, t, k) => p + (t - mt) * (zs[k] - mz), 0) / ts.reduce((p, t) => p + (t - mt) ** 2, 0);
        const res = zs.map((z, k) => z - (mz + slope * (ts[k] - mt)));
        const rms = Math.sqrt(res.reduce((p, r) => p + r * r, 0) / n) * 100;
        // swing clearance: middle 60 % of the non-contact interval after this run
        const sw = []; for (let k = 0; k < N; k++) { const i = (best[n - 1] + 1 + k) % N; if (c[i]) break; sw.push(i); }
        const mid = sw.slice(Math.floor(sw.length * 0.2), Math.ceil(sw.length * 0.8)); const clr = mid.length ? Math.min(...mid.map((i) => samples[i][f].ymin - off(i))) * 100 : NaN;
        const rel = (i) => ((samples[i][f].zc - samples[i][f].az) * 100).toFixed(0);
        summary.push(`${body.padEnd(9)} ${clipName.padEnd(4)} ${f} ${mode.padEnd(5)}: stance ${(best[0] / N).toFixed(2)}-${(((best[0] + n) % N) / N).toFixed(2)} ${(n / N * 100).toFixed(0).padStart(3)}%  v_fit ${(-slope).toFixed(2)} m/s  resid RMS ${rms.toFixed(1)} cm max ${(Math.max(...res.map(Math.abs)) * 100).toFixed(1)} | contact pt vs ankle: touchdown ${rel(best[0])} mid ${rel(best[Math.floor(n / 2)])} liftoff ${rel(best[n - 1])} cm | pitch ${samples[best[0]][f].pitch.toFixed(0)}->${samples[best[n - 1]][f].pitch.toFixed(0)}° | min mid-swing clearance ${clr.toFixed(1)} cm`);
      }
    }
  }
}
fs.writeFileSync(process.argv[3] ?? "contact.csv", rows.join("\n")); console.log(summary.join("\n"));
