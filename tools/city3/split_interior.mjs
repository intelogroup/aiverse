// Split a prebuilt house into the shell that streams with the street and the ground-floor contents that load only near its door.
//   bun tools/city3/split_interior.mjs SRC.glb OUT_DIR --scale=0.01 --volume=x0,x1,z0,z1 [--floor=0] [--top=2.6] [--inset=0.15]
//       [--shell=REGEX] [--floortex=MAT_REGEX:image.jpg:tile_m[;...]] [--keep=x0,x1,z0,z1[;...]]
// Units: metres in the source frame times --scale (what plan_slice prints), y up. Writes OUT_DIR/shell.glb (source frame, for place_house.mjs)
// and OUT_DIR/contents.glb: one mesh in the house frame place_house builds (footprint centre at x/z 0, lowest point at y 0, metres), so a layout
// places it at the house's outer transform (lot X, WALK_Y - SINK, lot Z).
// A connected component (triangles sharing a position) is contents when its material is not a shell material, its bbox lies inside the
// volume inset from the outer walls (window frames share materials with fittings but sit in the wall planes), and it ends below --top
// (ground floor; skylights and the upper storey stay in the shell). Flat upright cut-out people are deleted. --keep boxes force their
// components to stay in the shell (a counter that doubles as a wall). Prints every deletion and the moved triangle count per material.
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, metalRough, prune } from "@gltf-transform/functions";
import { mkdirSync, readFileSync } from "node:fs";

const [src, outDir, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? ""]; }));
if (!src || !outDir || !opt.volume) throw new Error("usage: split_interior.mjs SRC.glb OUT_DIR --scale=S --volume=x0,x1,z0,z1 [...]");
const S = Number(opt.scale ?? 1), [vx0, vx1, vz0, vz1] = opt.volume.split(",").map(Number);
const FLOOR = Number(opt.floor ?? 0), TOP = Number(opt.top ?? 2.6), IN = Number(opt.inset ?? 0.15);
const SHELL = new RegExp(opt.shell ?? "Wall|Ceiling|Floor_Joist|Sarki|Decking|Framing|Pressure|Hickory|Housewrap|Corrugated|Exterior|Architrave|Glass|Carpet", "i");
const keep = (opt.keep ? opt.keep.split(";") : []).map((s) => s.split(",").map(Number));
mkdirSync(outDir, { recursive: true });

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const read = async () => { const d = await io.read(src); if (d.getRoot().listExtensionsUsed().some((e) => e.extensionName === "KHR_materials_pbrSpecularGlossiness")) await d.transform(metalRough()); await d.transform(flatten()); return d; };
const shell = await read(), inner = await read();
const sceneOf = (d) => d.getRoot().getDefaultScene() ?? d.getRoot().listScenes()[0];
const bounds = getBounds(sceneOf(shell));

/** Union-find over triangles that share a (quantised) position: SketchUp exports split vertices per face, so indices alone never connect. */
function components(pos, idx, M) {
  const n = idx.length / 3, parent = Int32Array.from({ length: n }, (_, i) => i), seen = new Map();
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const W = [];
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    W.push([(M[0] * x + M[4] * y + M[8] * z + M[12]) * S, (M[1] * x + M[5] * y + M[9] * z + M[13]) * S, (M[2] * x + M[6] * y + M[10] * z + M[14]) * S]);
  }
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const p = W[idx[t * 3 + k]], key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
    const o = seen.get(key); if (o === undefined) seen.set(key, t); else { const a = find(o), b = find(t); if (a !== b) parent[a] = b; }
  }
  const box = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(t); let b = box.get(r); if (!b) box.set(r, (b = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], tris: [] }));
    b.tris.push(t);
    for (let k = 0; k < 3; k++) { const p = W[idx[t * 3 + k]]; for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], p[a]); b.max[a] = Math.max(b.max[a], p[a]); } }
  }
  return [...box.values()];
}

const inside = (b) => b.min[0] >= vx0 + IN && b.max[0] <= vx1 - IN && b.min[2] >= vz0 + IN && b.max[2] <= vz1 - IN && b.min[1] >= FLOOR - 0.05 && b.max[1] <= TOP;
const kept = (b) => keep.some(([x0, x1, z0, z1]) => b.max[0] > x0 && b.min[0] < x1 && b.max[2] > z0 && b.min[2] < z1);
// a cut-out person: one flat upright outline (many edge triangles), person-wide; door-frame strips and shower-screen frames are 2-tri or narrow
const person = (b) => { const d = [0, 1, 2].map((a) => b.max[a] - b.min[a]), w = Math.max(d[0], d[2]); return Math.min(d[0], d[2]) < 0.03 && d[1] > 1.3 && d[1] < 1.95 && w > 0.25 && w < 1.0 && b.tris.length >= 40; };
const moved = {}, deleted = [];
const sNodes = sceneOf(shell).listChildren(), iNodes = sceneOf(inner).listChildren();
sNodes.forEach((sn, ni) => {
  const sm = sn.getMesh(); if (!sm) return;
  const im = iNodes[ni].getMesh(), M = sn.getWorldMatrix();
  sm.listPrimitives().forEach((sp, pi) => {
    const ip = im.listPrimitives()[pi], mat = sp.getMaterial()?.getName() ?? "";
    const idxA = sp.getIndices()?.getArray() ?? Uint32Array.from({ length: sp.getAttribute("POSITION").getCount() }, (_, i) => i);
    const comps = components(sp.getAttribute("POSITION").getArray(), idxA, M);
    const sIdx = [], iIdx = [];
    for (const c of comps) {
      const tri = (t) => [idxA[t * 3], idxA[t * 3 + 1], idxA[t * 3 + 2]];
      // metal flats are shower-screen frames, not people
      if (!/glass|steel|alumin|chrome|metal/i.test(mat) && person(c)) { deleted.push(`${mat} ${c.tris.length} tris ${c.min.map((v) => v.toFixed(2))} .. ${c.max.map((v) => v.toFixed(2))}`); continue; }
      if (!SHELL.test(mat) && inside(c) && !kept(c)) { for (const t of c.tris) iIdx.push(...tri(t)); moved[mat] = (moved[mat] ?? 0) + c.tris.length; }
      else for (const t of c.tris) sIdx.push(...tri(t));
    }
    // fresh index accessors: after dedup two primitives may share one, and each side keeps a different subset
    const set = (doc, prim, list) => { if (!list.length) { prim.dispose(); return; } prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(list)).setBuffer(prim.getAttribute("POSITION").getBuffer())); };
    set(shell, sp, sIdx); set(inner, ip, iIdx);
  });
});

// --cut=x0,x1,y0,y1,z0,z1[;...]: open a doorway or a railing gap by removing the shell inside each box. Triangles that cross a box are clipped
// (Sutherland-Hodgman, every attribute interpolated), so a long rail loses only its middle and a door leaf goes with its frame left standing.
const cuts = (opt.cut ? opt.cut.split(";") : []).map((s) => s.split(",").map(Number));
function lerpV(a, b, t) { return { w: a.w.map((v, i) => v + (b.w[i] - v) * t), at: a.at.map((arr, k) => arr.map((v, i) => v + (b.at[k][i] - v) * t)) }; }
function splitPoly(poly, f) {
  const ins = [], out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a.w), fb = f(b.w);
    (fa >= 0 ? ins : out).push(a);
    if ((fa >= 0) !== (fb >= 0)) { const v = lerpV(a, b, fa / (fa - fb)); ins.push(v); out.push(v); }
  }
  return [ins, out];
}
/** The parts of a polygon outside an axis box (a list of polygons). */
function outsideBox(poly, [x0, x1, y0, y1, z0, z1]) {
  const planes = [(w) => w[0] - x0, (w) => x1 - w[0], (w) => w[1] - y0, (w) => y1 - w[1], (w) => w[2] - z0, (w) => z1 - w[2]];
  const kept = []; let cur = poly;
  for (const f of planes) { const [ins, out] = splitPoly(cur, f); if (out.length >= 3) kept.push(out); cur = ins; if (cur.length < 3) { cur = null; break; } }
  return cur ? kept : [poly];   // nothing reached the box's inside: keep the original untouched
}
let clipped = 0, dropped = 0;
if (cuts.length) for (const n of sceneOf(shell).listChildren()) {
  const m = n.getMesh(); if (!m) continue; const M = n.getWorldMatrix();
  for (const p of m.listPrimitives()) {
    const names = p.listSemantics(), accs = names.map((s) => p.getAttribute(s)), arrs = accs.map((a) => a.getArray()), sizes = accs.map((a) => a.getElementSize());
    const pos = arrs[names.indexOf("POSITION")], idx = p.getIndices().getArray(), nv = pos.length / 3;
    const W = (i) => [0, 1, 2].map((r) => (M[r] * pos[i * 3] + M[4 + r] * pos[i * 3 + 1] + M[8 + r] * pos[i * 3 + 2] + M[12 + r]) * S);
    const vert = (i) => ({ w: W(i), at: arrs.map((arr, k) => Array.from(arr.subarray(i * sizes[k], (i + 1) * sizes[k]))) });
    const extra = names.map(() => []), outIdx = []; let next = nv, touched = false;
    for (let t = 0; t < idx.length; t += 3) {
      let polys = [[idx[t], idx[t + 1], idx[t + 2]].map(vert)];
      const lo = [0, 1, 2].map((a) => Math.min(...polys[0].map((v) => v.w[a]))), hi = [0, 1, 2].map((a) => Math.max(...polys[0].map((v) => v.w[a])));
      const hits = cuts.filter(([x0, x1, y0, y1, z0, z1]) => hi[0] > x0 && lo[0] < x1 && hi[1] > y0 && lo[1] < y1 && hi[2] > z0 && lo[2] < z1);
      if (!hits.length) { outIdx.push(idx[t], idx[t + 1], idx[t + 2]); continue; }
      touched = true;
      for (const box of hits) polys = polys.flatMap((pl) => outsideBox(pl, box));
      if (!polys.length) { dropped++; continue; }
      clipped++;
      for (const pl of polys) {
        const base = next;
        for (const v of pl) { v.at.forEach((vals, k) => extra[k].push(...vals)); next++; }
        for (let i = 1; i + 1 < pl.length; i++) outIdx.push(base, base + i, base + i + 1);
      }
    }
    if (!touched) continue;
    const buf = accs[0].getBuffer();
    names.forEach((s, k) => {
      const Ctor = arrs[k].constructor, merged = new Ctor(arrs[k].length + extra[k].length); merged.set(arrs[k]); merged.set(extra[k], arrs[k].length);
      p.setAttribute(s, shell.createAccessor().setType(accs[k].getType()).setNormalized(accs[k].getNormalized()).setArray(merged).setBuffer(buf));
    });
    if (outIdx.length) p.setIndices(shell.createAccessor().setType("SCALAR").setArray(new Uint32Array(outIdx)).setBuffer(buf)); else p.dispose();
  }
}
if (cuts.length) console.log(`cut: ${dropped} triangles removed, ${clipped} clipped at ${cuts.length} box(es)`);

// --floortex=MAT_REGEX:diffuse.jpg:tile_m[:normal.jpg]: the up-facing triangles of those materials at floor height inside the volume move to one
// new textured floor material with world-scaled planar UVs (SketchUp's UVs follow its inch grid; its floor materials are shared with ceilings)
const texOf = (path) => shell.createTexture(path.split("/").pop()).setImage(new Uint8Array(readFileSync(path))).setMimeType(path.endsWith(".png") ? "image/png" : "image/jpeg");
for (const [k, spec] of (opt.floortex ? opt.floortex.split(";") : []).entries()) {
  const [re, img, tile, nrm] = spec.split(":"), rx = new RegExp(re);
  const fm = shell.createMaterial(`floor_${k}`).setBaseColorTexture(texOf(img)).setRoughnessFactor(0.55).setMetallicFactor(0);
  if (nrm) fm.setNormalTexture(texOf(nrm));
  let area = 0;
  for (const n of sceneOf(shell).listChildren()) {
    const m = n.getMesh(); if (!m) continue; const M = n.getWorldMatrix();
    for (const p of [...m.listPrimitives()]) {
      if (!rx.test(p.getMaterial()?.getName() ?? "")) continue;
      const pos = p.getAttribute("POSITION").getArray(), idx = p.getIndices().getArray(), nv = pos.length / 3, W = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) for (let r = 0; r < 3; r++) W[v * 3 + r] = (M[r] * pos[v * 3] + M[4 + r] * pos[v * 3 + 1] + M[8 + r] * pos[v * 3 + 2] + M[12 + r]) * S;
      const keepI = [], floorI = [];
      for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [W[i * 3], W[i * 3 + 1], W[i * 3 + 2]]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const ny = u[2] * w[0] - u[0] * w[2], L = Math.hypot(u[1] * w[2] - u[2] * w[1], ny, u[0] * w[1] - u[1] * w[0]);
        const cy = (a[1] + b[1] + c[1]) / 3, cx = (a[0] + b[0] + c[0]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
        const isFloor = L > 0 && ny / L > 0.9 && Math.abs(cy - FLOOR) < 0.04 && cx > vx0 && cx < vx1 && cz > vz0 && cz < vz1;
        (isFloor ? floorI : keepI).push(idx[t], idx[t + 1], idx[t + 2]); if (isFloor) area += L / 2;
      }
      if (!floorI.length) continue;
      const uv = new Float32Array(nv * 2); for (let v = 0; v < nv; v++) { uv[v * 2] = W[v * 3] / +tile; uv[v * 2 + 1] = W[v * 3 + 2] / +tile; }
      const buf = p.getAttribute("POSITION").getBuffer(), acc = (arr, type) => shell.createAccessor().setType(type).setArray(arr).setBuffer(buf);
      const fp = shell.createPrimitive().setMaterial(fm).setIndices(acc(new Uint32Array(floorI), "SCALAR")).setAttribute("POSITION", p.getAttribute("POSITION")).setAttribute("TEXCOORD_0", acc(uv, "VEC2"));
      if (p.getAttribute("NORMAL")) fp.setAttribute("NORMAL", p.getAttribute("NORMAL"));
      m.addPrimitive(fp);
      if (keepI.length) p.setIndices(acc(new Uint32Array(keepI), "SCALAR")); else p.dispose();
    }
  }
  console.log(`floor_${k}: ${area.toFixed(1)} m2 retextured from /${re}/`);
}

await shell.transform(prune(), dedup());
await io.write(`${outDir}/shell.glb`, shell);
// contents: into the house frame place_house builds (footprint-centred, base at y 0, metres), joined per material
const cx = (bounds.min[0] + bounds.max[0]) / 2, cz = (bounds.min[2] + bounds.max[2]) / 2;
const isc = sceneOf(inner), wrap = inner.createNode("contents").setTranslation([-cx * S, -bounds.min[1] * S, -cz * S]).setScale([S, S, S]);
for (const n of isc.listChildren()) { isc.removeChild(n); wrap.addChild(n); }
isc.addChild(wrap);
await inner.transform(prune(), dedup(), flatten(), join({ keepNamed: false }), prune());
await io.write(`${outDir}/contents.glb`, inner);
const sb = getBounds(sceneOf(await io.read(`${outDir}/shell.glb`)));
const drift = Math.max(...[0, 1, 2].map((a) => Math.max(Math.abs(sb.min[a] - bounds.min[a]), Math.abs(sb.max[a] - bounds.max[a])))) * S;
console.log("deleted (cut-out people):"); for (const d of deleted) console.log("  " + d);
console.log("moved to contents (tris by material):", JSON.stringify(moved));
console.log(`house frame: centre ${(cx * S).toFixed(3)}, ${(cz * S).toFixed(3)}, base ${(bounds.min[1] * S).toFixed(3)}; shell bounds drift ${drift.toFixed(4)} m`);
if (drift > 0.001) throw new Error("the shell's bounds changed: place_house would centre it differently from contents.glb");
