#!/usr/bin/env bun
// Build the far LOD: a textured, exterior-only copy of the Bazaar for the opening aerial, split into one `shell_<tileId>` group per
// world tile so the runtime's existing rule (a shell group hides once its tile's detail is loaded) removes it tile by tile.
//   bun tools/city3/split_lod.mjs <world-city3.glb> <tilesDir>     reads <tilesDir>/tiles.json, writes <tilesDir>/lod.<hash>.glb
// What is kept: building shells (shop bones, ground-floor shells, facades, roofs), roads, lawns, trees, lamps. What is dropped: goods,
// furniture, bathroom fixtures, Tea House props and floors, interior walls, lights. Textures: base colour only (no normal / roughness /
// occlusion / emissive maps), and none for interior-only materials (doors, Tea props, floors). All of it is embedded: the LOD is
// one request. Run after split_world.mjs (needs its tiles.json).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from "@gltf-transform/extensions";
import { prune, dedup, join, meshopt } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeCellOf, leafOfCell, subset } from "./tile_grid.mjs";

const [IN, DIR] = process.argv.slice(2);
const MAX_BYTES = 5_000_000; // the agreed budget for the far view (5 MB) plus a little slack; the build fails above it
const BIG_TRI = 40; // m: wider triangles ride in the core tile (same rule as split_world / split_shell: no holes where a tile is not loaded)
const DROP_EXTRA = process.env.DROP_EXTRA ? "|" + process.env.DROP_EXTRA : "";
const DROP = new RegExp("^(inst_goods|BzInt|bathroom|toilet|SK_|LIB|Fountain|Props|PartyCups|ls_(flower|bush|path|rock)|InteriorWalls|LampGlow|Door_shop|TeaProp|TeaFloor|TeaWay|Shutters|inst_door|BladeSigns" + DROP_EXTRA + ")");
const NO_TEXTURE = /^(Tea|BzDoor|ph_|trim_|floor_|G_|shutters)/; // interior-only materials: flat colour is enough from far away

const T = JSON.parse(readFileSync(`${DIR}/tiles.json`, "utf8"));
const layoutIds = T.layout.map(t => t.id), core = T.layout.findIndex(t => t.core);
const cellOf = makeCellOf(T.heroes), leaf = leafOfCell(T.layout, T.heroes);

await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(IN); const root = doc.getRoot(); const scene = root.listScenes()[0];
const buffer = root.listBuffers()[0];
const instExt = doc.createExtension(EXTMeshGPUInstancing);

// materials first: drop everything but base colour
for (const m of root.listMaterials()) {
  m.setNormalTexture(null); m.setMetallicRoughnessTexture(null); m.setOcclusionTexture(null); m.setEmissiveTexture(null);
  if (NO_TEXTURE.test(m.getName())) m.setBaseColorTexture(null);
  const far = m.getExtras()?.far_color; if (far) { m.setBaseColorTexture(null); m.setBaseColorFactor([...far, 1]); } // townhouse kit: mean colour from far away (their textures are ~3 MB)
  if (/^cobble/.test(m.getName())) { m.setBaseColorTexture(null); m.setBaseColorFactor([0.43, 0.38, 0.34, 1]); } // 1024 px paving: flat stone from far away (0.18 MB)
  if (/^roof_hall/.test(m.getName())) { m.setBaseColorTexture(null); m.setBaseColorFactor([0.42, 0.2, 0.14, 1]); } // one big barrel roof: a flat terracotta from far away saves 0.2 MB
}

const meshCentre = (mesh, M) => { // world xz of the local bounding-box centre
  let lo = [1e18, 1e18, 1e18], hi = [-1e18, -1e18, -1e18];
  for (const p of mesh.listPrimitives()) { const a = p.getAttribute("POSITION"); const mn = a.getMin([]), mx = a.getMax([]); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], mn[k]); hi[k] = Math.max(hi[k], mx[k]); } }
  const c = lo.map((v, k) => (v + hi[k]) / 2); return [wx(M, c[0], c[1], c[2]), wz(M, c[0], c[1], c[2])];
};
// Interior-only primitives inside kept meshes (the shop "bones" carry their stairs, partitions, slabs and landings): not visible from outside.
const INTERIOR = /^(ls_bones_(stair|partition|slab|landing)|TeaProp|PlazaFountainGarden)/;
{
  const seenM = new Set(); let gone = 0;
  for (const n of root.listNodes()) {
    const mesh = n.getMesh(); if (!mesh || seenM.has(mesh) || DROP.test(n.getName())) continue; seenM.add(mesh);
    for (const prim of mesh.listPrimitives()) if (INTERIOR.test(prim.getMaterial()?.getName() ?? "")) { mesh.removePrimitive(prim); prim.dispose(); gone++; }
  }
  console.log(`removed ${gone} interior-only primitives`);
}
// Far away, a tree or a shopfront needs a fraction of its triangles. Simplify each kept source mesh once (shared meshes stay shared).
const TREE = /^(ls_tree|Tree_)/, TREE_RATIO = Number(process.env.TREE_RATIO ?? 0.1), BLD_RATIO = Number(process.env.BLD_RATIO ?? 0.3), KIT_RATIO = Number(process.env.KIT_RATIO ?? 0.15); // the townhouse rows are flat-coloured from far away, so they take fewer triangles
{
  const done = new Set();
  for (const n of root.listNodes()) {
    const mesh = n.getMesh(); if (!mesh || done.has(mesh) || DROP.test(n.getName())) continue; done.add(mesh);
    const ratio = TREE.test(n.getName()) ? TREE_RATIO : /^Kit_(shop|hall)/.test(n.getName()) ? KIT_RATIO : BLD_RATIO, err = TREE.test(n.getName()) ? Number(process.env.TREE_ERR ?? 1) : /^Kit_(shop|hall)/.test(n.getName()) ? Number(process.env.KIT_ERR ?? 0.3) : Number(process.env.BLD_ERR ?? 0.05);
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices(); if (!idx || prim.getMode() !== 4) continue; const ia = idx.getArray();
      if (ia.length < 90) continue; // tiny pieces (doors, lamps) are cheaper left alone
      const pos = prim.getAttribute("POSITION").getArray(); let src = Uint32Array.from(ia);
      if (/^Kit_(shop|hall)/.test(n.getName())) { // UV seams leave equal positions on separate vertices, which the simplifier treats as locked borders (stuck at 73%): collapse them onto one representative first
        const rep = new Map(); src = src.map(i => { const k = `${pos[3 * i]},${pos[3 * i + 1]},${pos[3 * i + 2]}`; if (!rep.has(k)) rep.set(k, i); return rep.get(k); });
      }
      // the market hall is trusswork that edge collapse stops short on (4618 -> 3741 tris at any ratio): from far away it only needs a silhouette, so the topology-blind simplifier does it
      const target = Math.max(36, Math.floor(ia.length * ratio / 3) * 3);
      const [ni] = /^Kit_hall/.test(n.getName()) ? MeshoptSimplifier.simplifySloppy(src, pos, 3, null, target, err) : MeshoptSimplifier.simplify(src, pos, 3, target, err);
      prim.setIndices(doc.createAccessor().setArray(ia.length < 65536 || Math.max(...ni) < 65536 ? Uint16Array.from(ni) : ni).setType("SCALAR").setBuffer(buffer));
    }
  }
}
const groups = new Map(); // leaf index -> parent node `shell_<id>`
const group = li => { let g = groups.get(li); if (!g) { g = doc.createNode(`shell_${layoutIds[li]}`); scene.addChild(g); groups.set(li, g); } return g; };
const wx = (M, x, y, z) => M[0] * x + M[4] * y + M[8] * z + M[12], wz = (M, x, y, z) => M[2] * x + M[6] * y + M[10] * z + M[14];
const owners = new Map(); for (const n of root.listNodes()) { const m = n.getMesh(); if (m) owners.set(m, (owners.get(m) ?? 0) + 1); }
let kept = 0, dropped = 0, trisIn = 0, shared = 0;
for (const n of [...root.listNodes()]) {
  const mesh = n.getMesh(); if (!mesh) continue;
  if (DROP.test(n.getName())) { dropped++; continue; }
  kept++;
  const M = n.getWorldMatrix();
  const inst = n.getExtension("EXT_mesh_gpu_instancing");
  if (inst) { // instanced (trees, doors): one instanced child per tile, the instances whose position falls in it
    const tr = inst.getAttribute("TRANSLATION"), a = tr.getArray(), cnt = tr.getCount(); const per = new Map();
    for (let i = 0; i < cnt; i++) { const li = leaf[cellOf(wx(M, a[i * 3], a[i * 3 + 1], a[i * 3 + 2]), wz(M, a[i * 3], a[i * 3 + 1], a[i * 3 + 2]))]; (per.get(li) ?? per.set(li, []).get(li)).push(i); }
    for (const [li, keep] of per) {
      const im = instExt.createInstancedMesh();
      for (const sem of inst.listSemantics()) {
        const acc = inst.getAttribute(sem), arr = acc.getArray(), sz = acc.getElementSize(); const out = new arr.constructor(keep.length * sz);
        keep.forEach((i, o) => { for (let c = 0; c < sz; c++) out[o * sz + c] = arr[i * sz + c]; });
        im.setAttribute(sem, doc.createAccessor().setArray(out).setType(acc.getType()).setNormalized(acc.getNormalized()).setBuffer(buffer));
      }
      group(li).addChild(doc.createNode(n.getName()).setMesh(mesh).setMatrix(M).setExtension("EXT_mesh_gpu_instancing", im));
    }
    trisIn += (mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0)) * cnt;
    continue;
  }
  if (owners.get(mesh) > 1) { // one mesh placed by several nodes (props): keep it shared (named, so join leaves it alone) and put each placement in the tile of its position
    const [bx, bz] = meshCentre(mesh, M); group(leaf[cellOf(bx, bz)]).addChild(doc.createNode("").setMesh(mesh).setMatrix(M)); shared++; continue;
  }
  // plain mesh: split every primitive by triangle centroid into tiles
  const byLeaf = new Map();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const pos = prim.getAttribute("POSITION").getArray(), idx = prim.getIndices()?.getArray(); const nt = (idx ? idx.length : pos.length / 3) / 3; const per = new Map();
    for (let t = 0; t < nt; t++) {
      let cx = 0, cz = 0, x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
      for (let k = 0; k < 3; k++) { const v = idx ? idx[t * 3 + k] : t * 3 + k; const X = wx(M, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]), Z = wz(M, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); cx += X; cz += Z; x0 = Math.min(x0, X); x1 = Math.max(x1, X); z0 = Math.min(z0, Z); z1 = Math.max(z1, Z); }
      const li = Math.max(x1 - x0, z1 - z0) > BIG_TRI ? core : leaf[cellOf(cx / 3, cz / 3)];
      (per.get(li) ?? per.set(li, []).get(li)).push(t);
    }
    trisIn += nt;
    for (const [li, tris] of per) (byLeaf.get(li) ?? byLeaf.set(li, []).get(li)).push({ prim, tris });
  }
  for (const [li, parts] of byLeaf) {
    const m = doc.createMesh("");
    for (const { prim, tris } of parts) { const p = prim.clone(); subset(doc, p, Int32Array.from(tris)); m.addPrimitive(p); }
    group(li).addChild(doc.createNode("").setMesh(m).setMatrix(M));
  }
}
// remove the original nodes (everything not under a shell_ group), then everything they alone referenced
for (const n of [...scene.listChildren()]) if (!n.getName().startsWith("shell_")) n.dispose();
for (const n of root.listNodes()) if (!n.getName().startsWith("shell_") && n.listParents().every(p => p === scene)) n.dispose();
for (const n of root.listNodes()) n.setExtension("KHR_lights_punctual", null);
await doc.transform(prune({ keepLeaves: false }), dedup());
const draws = () => root.listMeshes().reduce((a, m) => a + m.listPrimitives().length, 0);
const before = draws();
await doc.transform(join({ keepMeshes: false, keepNamed: true }), prune({ keepLeaves: false, keepAttributes: false })); // fewer draw calls: one primitive per material per tile
console.log(`kept ${kept} nodes, dropped ${dropped}; ${groups.size} tile groups, ${shared} shared-mesh placements; ${Math.round(trisIn)} tris in; draw calls ${before} -> ${draws()}`);
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" })); // quantizes positions/normals/UVs, then compresses
const out = Buffer.from(await io.writeBinary(doc));
for (const f of readdirSync(DIR)) if (/^lod\.[0-9a-f]+\.glb$/.test(f)) unlinkSync(`${DIR}/${f}`);
const name = `lod.${createHash("sha1").update(out).digest("hex").slice(0, 10)}.glb`;
writeFileSync(`${DIR}/${name}`, out);
console.log(`${name}: ${(out.length / 1e6).toFixed(2)} MB`);
if (out.length > MAX_BYTES) { console.error(`far LOD is ${(out.length / 1e6).toFixed(2)} MB, over the ${(MAX_BYTES / 1e6).toFixed(1)} MB budget`); process.exit(1); }
