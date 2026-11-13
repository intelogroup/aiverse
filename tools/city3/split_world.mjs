#!/usr/bin/env bun
// Split the Bazaar world GLB into streamable tiles (option B of the phone-load plan).
//   bun tools/city3/split_world.mjs <in.glb> <outDir> [--dry] [--why] [--limit=150000] [--core-half=9] [--hero=name:x0,z0,x1,z1;...] [--layout=<tiles.json>]
//   --hero    a world-space rectangle that becomes its own tile whatever the grid says (the Tea House: its door and lift are edited at runtime and need all their pieces in one scene)
//   --layout  reuse another run's tile squares and heroes, so the collision tiles match the visual ones 1:1
// Tiles are 3x3-nested squares around the spawn (0,0): the centre cell of every level contains the origin,
// so the first-load "core" tile is centred on the fountain. Whole small meshes go to one tile by bbox centre;
// large single-owner meshes (ground, props, roads) are split by triangle centroid; instanced props by instance position.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { cloneDocument, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT_HALF, FINE, N, makeCellOf, cellsOfSquare, subset } from "./tile_grid.mjs";

const args = process.argv.slice(2);
const flag = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const [IN, OUT] = args.filter(a => !a.startsWith("--"));
const DRY = args.includes("--dry");
const LAYOUT = flag("layout", ""); // reuse another run's tile squares (collision follows the visual tiles 1:1)
const LIMIT = Number(flag("limit", 150000));
const CORE_HALF = Number(flag("core-half", 9)); // must be 243/3^k (9 = an 18 m square on the fountain; 27 carries 5 MB, see docs)
const BIG_TRI = Number(flag("big-tri", 40)); let bigTris = 0; // m
const WHOLE_MAX = 20; // m: a single-owner mesh smaller than this goes to one tile (no cut buildings)
const LAYOUT_JSON = LAYOUT ? JSON.parse(readFileSync(LAYOUT, "utf8")) : null;
const HEROES = LAYOUT_JSON ? LAYOUT_JSON.heroes : flag("hero", "").split(";").filter(Boolean).map(h => { const [name, r] = h.split(":"); return { name, rect: r.split(",").map(Number) }; });
const cellOf = makeCellOf(HEROES);

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
const src = await io.read(IN);
const nodes = src.getRoot().listNodes();
const meshOwners = new Map();
for (const n of nodes) { const m = n.getMesh(); if (m) meshOwners.set(m, (meshOwners.get(m) ?? 0) + 1); }

const wx = (m, x, y, z) => m[0] * x + m[4] * y + m[8] * z + m[12];
const wz = (m, x, y, z) => m[2] * x + m[6] * y + m[10] * z + m[14];
const meshTris = m => m.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3, 0);

// ---- pass A: where does everything go (fine cell per triangle / node / instance) ----
const plan = new Map(); // node index -> {kind, ...}
const weight = new Float64Array(N * N + HEROES.length); // rendered triangles per fine cell
const skipped = { nonTri: 0 };
const WHY = args.includes('--why'); const why = new Map(); const addWhy = (cell, key, t) => { if (!WHY) return; const m = why.get(cell) ?? new Map(); m.set(key, (m.get(key) ?? 0) + t); why.set(cell, m); };
nodes.forEach((n, ni) => {
  const M = n.getWorldMatrix();
  if (n.getExtension("KHR_lights_punctual")) { plan.set(ni, { kind: "light", cell: cellOf(M[12], M[14]) }); return; }
  const mesh = n.getMesh(); if (!mesh) return;
  const inst = n.getExtension("EXT_mesh_gpu_instancing");
  const tris = meshTris(mesh);
  if (inst) {
    const t = inst.getAttribute("TRANSLATION"); const cnt = t.getCount(); const a = t.getArray(); const cells = new Uint16Array(cnt);
    for (let i = 0; i < cnt; i++) { cells[i] = cellOf(wx(M, a[i * 3], a[i * 3 + 1], a[i * 3 + 2]), wz(M, a[i * 3], a[i * 3 + 1], a[i * 3 + 2])); weight[cells[i]] += tris; addWhy(cells[i], 'inst:' + (n.getName() || mesh.getName()), tris); }
    plan.set(ni, { kind: "inst", cells }); return;
  }
  const prims = mesh.listPrimitives();
  if (prims.some(p => p.getMode() !== 4)) skipped.nonTri++;
  // world bbox in xz
  let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
  for (const p of prims) { const a = p.getAttribute("POSITION").getArray(), c = a.length / 3; for (let i = 0; i < c; i++) { const X = wx(M, a[i * 3], a[i * 3 + 1], a[i * 3 + 2]), Z = wz(M, a[i * 3], a[i * 3 + 1], a[i * 3 + 2]); if (X < x0) x0 = X; if (X > x1) x1 = X; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z; } }
  const owners = meshOwners.get(mesh);
  if (owners > 1 || Math.max(x1 - x0, z1 - z0) < WHOLE_MAX || prims.some(p => p.getMode() !== 4)) {
    const cell = cellOf((x0 + x1) / 2, (z0 + z1) / 2); weight[cell] += tris; addWhy(cell, 'whole:' + (n.getName() || mesh.getName()), tris); plan.set(ni, { kind: "whole", cell }); return;
  }
  const per = prims.map(p => {
    const pos = p.getAttribute("POSITION").getArray(), idx = p.getIndices()?.getArray(); const T = (idx ? idx.length : pos.length / 3) / 3; const cells = new Uint16Array(T);
    for (let t = 0; t < T; t++) {
      let cx = 0, cz = 0, x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx[t * 3 + k] : t * 3 + k; const X = wx(M, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]), Z = wz(M, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        cx += X; cz += Z; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
      }
      // A triangle wider than BIG_TRI would leave a hole wherever its (far) tile is not loaded yet: ground and water quads are the case.
      // They ride in the always-loaded core instead (cheap: they are few and large, not detailed).
      if (Math.max(x1 - x0, z1 - z0) > BIG_TRI) { cells[t] = cellOf(0, 0); bigTris++; } else cells[t] = cellOf(cx / 3, cz / 3);
      weight[cells[t]]++; if (WHY) addWhy(cells[t], 'split:' + (n.getName() || mesh.getName()), 1);
    }
    return cells;
  });
  plan.set(ni, { kind: "split", per });
});
const totalTris = weight.reduce((a, b) => a + b, 0);

// ---- tiling: 3x3 nested squares; the origin-centred core never splits ----
const tiles = []; // {id, cx, cz, half, cells:Set, tris}
function build(cx, cz, half, level) {
  const cells = []; let tris = 0;
  const i0 = Math.round((cx - half + ROOT_HALF) / FINE), i1 = Math.round((cx + half + ROOT_HALF) / FINE), j0 = Math.round((cz - half + ROOT_HALF) / FINE), j1 = Math.round((cz + half + ROOT_HALF) / FINE);
  const edgeLo = (v) => v === 0, edgeHi = (v) => v === N; // outermost cells also own everything beyond the root square (clamped)
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { cells.push(j * N + i); tris += weight[j * N + i]; }
  const isCore = cx === 0 && cz === 0 && half === CORE_HALF;
  if (half <= FINE / 2 || isCore || (tris <= LIMIT && !(cx === 0 && cz === 0 && half > CORE_HALF))) {
    tiles.push({ id: `t${level}_${i0}_${j0}`, cx, cz, half, cells, tris, core: isCore });
    return;
  }
  const w = half / 3 * 2;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) build(cx + dx * w, cz + dz * w, half / 3, level + 1);
}
if (LAYOUT_JSON) { // collision (or any sibling file): same squares as the visual run, so tile ids and rects match
  for (const t of LAYOUT_JSON.layout) {
    const cells = []; let tris = 0;
    if (t.hero !== undefined) { cells.push(N * N + t.hero); tris = weight[N * N + t.hero]; }
    else { const i0 = Math.round((t.cx - t.half + ROOT_HALF) / FINE), i1 = Math.round((t.cx + t.half + ROOT_HALF) / FINE), j0 = Math.round((t.cz - t.half + ROOT_HALF) / FINE), j1 = Math.round((t.cz + t.half + ROOT_HALF) / FINE); for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { cells.push(j * N + i); tris += weight[j * N + i]; } }
    tiles.push({ id: t.id, cx: t.cx, cz: t.cz, half: t.half, cells, tris, core: t.core, hero: t.hero });
  }
} else {
  build(0, 0, ROOT_HALF, 0);
  HEROES.forEach((h, k) => tiles.push({ id: h.name, cx: (h.rect[0] + h.rect[2]) / 2, cz: (h.rect[1] + h.rect[3]) / 2, half: Math.max(h.rect[2] - h.rect[0], h.rect[3] - h.rect[1]) / 2, cells: [N * N + k], tris: weight[N * N + k], hero: k }));
}
const cover = tiles.reduce((a, t) => a + t.tris, 0); const layout = tiles.map(t => ({ id: t.id, cx: t.cx, cz: t.cz, half: t.half, core: t.core || undefined, hero: t.hero }));
console.log(`${bigTris} wide triangles (> ${BIG_TRI} m) pinned to the core`);
console.log(`world ${totalTris} rendered tris; ${tiles.length} tiles cover ${cover} (${cover === totalTris ? "ok" : "MISMATCH"}); skipped nonTri nodes: ${skipped.nonTri}`);
for (const t of [...tiles].sort((a, b) => b.tris - a.tris).slice(0, 8)) console.log(`  ${t.id} half ${t.half} at ${t.cx},${t.cz}: ${t.tris}${t.core ? "  CORE" : ""}`);
const core = tiles.find(t => t.core); console.log("core tris", core?.tris, "| tiles over limit:", tiles.filter(t => t.tris > LIMIT && !t.core).length);
if (WHY && core) { const agg = new Map(); for (const c of core.cells) for (const [k, v] of why.get(c) ?? []) agg.set(k, (agg.get(k) ?? 0) + v); console.log([...agg].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `  ${v} ${k}`).join('\n')); }
if (DRY) process.exit(0);

// ---- pass B: write each tile ----
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT + "/tex", { recursive: true });
const leafOfCell = new Int32Array(N * N + HEROES.length).fill(-1);
tiles.forEach((t, ti) => t.cells.forEach(c => (leafOfCell[c] = ti)));
const manifest = [];
// Textures are written once, content-hashed, outside the tiles (tiles reference them by relative uri): the monolith's 374 images
// would otherwise be embedded again in every tile that uses them (measured 144 of 218 MB). Tile names carry a content hash too,
// so every file under OUT is immutable-cacheable; only the manifest changes between builds.
const sha = b => createHash("sha1").update(b).digest("hex").slice(0, 16);
const EXT = { "image/ktx2": "ktx2", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
let texBytes = 0; const texSeen = new Set();
async function writeTile(doc, id) {
  const { json, resources } = await io.writeJSON(doc, { basename: "tile" });
  // buffer 0 holds the data; a second uri-less buffer is meshopt's virtual fallback (same layout as the monolith)
  if (json.buffers.filter(x => x.uri).length !== 1 || !json.buffers[0].uri) throw new Error(`${id}: unexpected buffer layout`);
  const bin = resources[json.buffers[0].uri]; delete json.buffers[0].uri;
  for (const im of json.images ?? []) {
    const data = resources[im.uri]; const name = `tex/${sha(data)}.${EXT[im.mimeType] ?? "bin"}`;
    if (!texSeen.has(name)) { texSeen.add(name); texBytes += data.length; writeFileSync(`${OUT}/${name}`, data); }
    im.uri = name;
  }
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const b = Buffer.concat([Buffer.from(bin), Buffer.alloc((4 - bin.length % 4) % 4)]);
  const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + b.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.write(type, 4, "latin1"); return h; };
  const glb = Buffer.concat([head, ch(js.length, "JSON"), js, ch(b.length, "BIN\0"), b]);
  const file = `${id}.${sha(glb).slice(0, 10)}.glb`; writeFileSync(`${OUT}/${file}`, glb);
  return { file, bytes: glb.length };
}
for (let ti = 0; ti < tiles.length; ti++) {
  const T = tiles[ti]; const doc = cloneDocument(src); const dn = doc.getRoot().listNodes();
  if (dn.length !== nodes.length) throw new Error("clone node count mismatch");
  dn.forEach((n, ni) => {
    const p = plan.get(ni); if (!p) return;
    if (p.kind === "light") { if (leafOfCell[p.cell] !== ti) n.setExtension("KHR_lights_punctual", null); return; }
    if (p.kind === "whole") { if (leafOfCell[p.cell] !== ti) n.setMesh(null); return; }
    if (p.kind === "inst") {
      const ext = n.getExtension("EXT_mesh_gpu_instancing"); const keep = []; p.cells.forEach((c, i) => { if (leafOfCell[c] === ti) keep.push(i); });
      if (!keep.length) { n.setMesh(null); n.setExtension("EXT_mesh_gpu_instancing", null); return; }
      if (keep.length === p.cells.length) return;
      for (const sem of ext.listSemantics()) {
        const a = ext.getAttribute(sem), arr = a.getArray(), sz = a.getElementSize(); const out = new arr.constructor(keep.length * sz);
        keep.forEach((i, o) => { for (let c = 0; c < sz; c++) out[o * sz + c] = arr[i * sz + c]; });
        ext.setAttribute(sem, doc.createAccessor().setArray(out).setType(a.getType()).setNormalized(a.getNormalized()).setBuffer(a.getBuffer()));
      }
      return;
    }
    const mesh = n.getMesh(); const prims = mesh.listPrimitives();
    prims.forEach((prim, pi) => {
      const keep = []; p.per[pi].forEach((c, t) => { if (leafOfCell[c] === ti) keep.push(t); });
      if (!keep.length) { mesh.removePrimitive(prim); prim.dispose(); return; }
      if (keep.length !== p.per[pi].length) subset(doc, prim, Int32Array.from(keep));
    });
    if (!mesh.listPrimitives().length) n.setMesh(null);
  });
  await doc.transform(prune({ keepLeaves: false, keepAttributes: false }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  if (!doc.getRoot().listNodes().some(n => n.getMesh() || n.getExtension("KHR_lights_punctual"))) continue; // nothing of this file lands in this square
  const { file, bytes } = await writeTile(doc, T.id);
  manifest.push({ id: T.id, url: file, center: [T.cx, T.cz], half: T.half, tris: T.tris, bytes, core: T.core || undefined });
  console.log(`${T.id} ${T.core ? "CORE " : ""}tris ${T.tris} -> ${(bytes / 1048576).toFixed(2)} MB`);
}
writeFileSync(`${OUT}/tiles.json`, JSON.stringify({ source: IN, rootHalf: ROOT_HALF, limit: LIMIT, totalTris, textureBytes: texBytes, heroes: HEROES, layout, tiles: manifest }, null, 1));
console.log(`textures ${texSeen.size} files, ${(texBytes / 1048576).toFixed(1)} MB (shared); tiles ${(manifest.reduce((a, t) => a + t.bytes, 0) / 1048576).toFixed(1)} MB`);
