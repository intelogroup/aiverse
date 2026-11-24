// Place small prebuilt props (loungers, parasols, chairs) as one stand-alone streamed district: one GLB with one GPU-instanced mesh per
// prop model, one collision GLB with a box per instance, and a `props-<id>` entry in districts.json (tiles_manifest.mjs carries it).
// Not `house-*`: five tools read every house-* district as a building footprint (clear_footprints, grounds, ring frontage, ...).
//   import { placeProps } from "./place_props.mjs"; await placeProps({ id, name, center: [x, z], half, y, props: [...] })
//   props: { name, src, scale, col: [hx, hz, h] | null, at: [[x, z, yawDeg], ...] }   (yaw a multiple of 90 when col is set)
// Each model is normalised: footprint centred on its local origin, lowest point at y 0, local +z kept as its front.
import { Document, NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from "@gltf-transform/extensions";
import { dedup, flatten, mergeDocuments, metalRough, prune, transformMesh } from "@gltf-transform/functions";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const A = "apps/console/public/assets";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const yawQ = (deg) => { const h = (deg * Math.PI) / 360; return [0, Math.sin(h), 0, Math.cos(h)]; };

/** One mesh holding every primitive of `src`, scaled, footprint-centred, base at y 0 (a mesh of the source document). */
async function propMesh(src, S) {
  const doc = await io.read(src);
  if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === "KHR_materials_pbrSpecularGlossiness")) await doc.transform(metalRough());
  await doc.transform(flatten());
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const b = getBounds(scene), cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const out = doc.createMesh("prop");
  for (const n of scene.listChildren()) {
    const m = n.getMesh(); if (!m) continue;
    const copy = m.clone(); const w = n.getWorldMatrix().slice();
    // world = T(-c) * S * nodeWorld  (column-major: scale rows, then shift the translation column)
    for (let i = 0; i < 16; i++) if (i % 4 !== 3) w[i] *= S;
    w[12] -= cx * S; w[13] -= b.min[1] * S; w[14] -= cz * S;
    transformMesh(copy, w);
    for (const p of copy.listPrimitives()) out.addPrimitive(p);
  }
  return { doc, mesh: out, size: [(b.max[0] - b.min[0]) * S, (b.max[1] - b.min[1]) * S, (b.max[2] - b.min[2]) * S] };
}

export async function placeProps(L) {
  const out = new Document(); const buf = out.createBuffer(); const scene = out.createScene(L.id); out.getRoot().setDefaultScene(scene);
  const inst = out.createExtension(EXTMeshGPUInstancing).setRequired(true);
  const col = new Document(); const cbuf = col.createBuffer(); const csc = col.createScene("col"); const cmat = col.createMaterial("col");
  const cube = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  let boxes = 0;
  for (const p of L.props) {
    const { doc, mesh, size } = await propMesh(p.src, p.scale ?? 1);
    const map = mergeDocuments(out, doc);
    const m = map.get(mesh);
    const n = p.at.length, T = new Float32Array(n * 3), R = new Float32Array(n * 4);
    p.at.forEach(([x, z, yaw], i) => { T.set([x, L.y, z], i * 3); R.set(yawQ(yaw), i * 4); });
    const acc = (arr, type) => out.createAccessor().setType(type).setArray(arr).setBuffer(buf);
    scene.addChild(out.createNode(`props_${p.name}`).setMesh(m).setExtension("EXT_mesh_gpu_instancing",
      inst.createInstancedMesh().setAttribute("TRANSLATION", acc(T, "VEC3")).setAttribute("ROTATION", acc(R, "VEC4"))));
    console.log(`${p.name}: ${n} x ${size.map((v) => v.toFixed(2)).join(" x ")} m`);
    if (!p.col) continue;
    const [hx, hz, h] = p.col;
    for (const [x, z, yaw] of p.at) {
      if (yaw % 90) throw new Error(`${p.name}: collision needs a yaw in 90-degree steps`);
      const [ex, ez] = (yaw / 90) % 2 ? [hz, hx] : [hx, hz], c = [x, L.y + h / 2, z], e = [ex, h / 2, ez];
      const pos = new Float32Array(cube.flatMap((v) => [c[0] + v[0] * e[0], c[1] + v[1] * e[1], c[2] + v[2] * e[2]]));
      const prim = col.createPrimitive().setMaterial(cmat)
        .setAttribute("POSITION", col.createAccessor().setType("VEC3").setArray(pos).setBuffer(cbuf))
        .setIndices(col.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(cbuf));
      csc.addChild(col.createNode(`col_props_${L.id}_${boxes++}`).setMesh(col.createMesh().addPrimitive(prim)));
    }
  }
  // drop the merged source scenes (their nodes and meshes), keep the instanced nodes; one buffer for the GLB
  for (const s of out.getRoot().listScenes()) if (s !== scene) s.dispose();
  for (const b of out.getRoot().listBuffers()) if (b !== buf) { for (const a of out.getRoot().listAccessors()) if (a.getBuffer() === b) a.setBuffer(buf); b.dispose(); }
  await out.transform(prune({ keepLeaves: false }), dedup());
  mkdirSync(`${A}/props`, { recursive: true });
  await io.write(`${A}/props/${L.id}.glb`, out);
  await new NodeIO().write(`${A}/props/${L.id}.col.glb`, col);

  // self-check: every placement made it into the GLB, one box per collidable placement
  const back = await io.read(`${A}/props/${L.id}.glb`);
  const got = back.getRoot().listNodes().reduce((s, n) => s + (n.getExtension("EXT_mesh_gpu_instancing")?.getAttribute("TRANSLATION").getCount() ?? 0), 0);
  const want = L.props.reduce((s, p) => s + p.at.length, 0), wantBoxes = L.props.reduce((s, p) => s + (p.col ? p.at.length : 0), 0);
  if (got !== want || boxes !== wantBoxes) throw new Error(`place_props: ${got}/${want} instances, ${boxes}/${wantBoxes} boxes`);

  const def = { id: `props-${L.id}`, name: L.name, url: `/assets/props/${L.id}.glb`, collisionUrl: `/assets/props/${L.id}.col.glb`, center: L.center, half: L.half, origin: [0, 0], theme: "bazaar" };
  const mpath = `${A}/districts.json`, man = JSON.parse(readFileSync(mpath, "utf8"));
  const at = man.districts.findIndex((d) => d.id === def.id);
  if (at < 0) man.districts.push(def); else man.districts[at] = def;
  writeFileSync(mpath, JSON.stringify(man, null, 1));
  console.log(`props-${L.id}: ${want} props, ${boxes} collision boxes`);
}
