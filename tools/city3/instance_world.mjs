// Fold repeated street props into GPU instances (EXT_mesh_gpu_instancing) on a COPY of the world, for the tile split only.
// Usage: bun tools/city3/instance_world.mjs <in.glb> <out.glb>     (selftest: bun tools/city3/instance_world.mjs --selftest)
//
// Why: walking at the cabin drew ~4,900 calls a frame, about a third of them the same three tree models (one draw per primitive per
// clone), plus lanterns, stall crates and benches. The clones already share one glTF Mesh each, so one instanced node per Mesh renders
// them in one draw per primitive per tile (split_world splits instanced nodes by instance position, so culling stays per tile).
// Only an allowlist of street props is folded: names the runtime looks up (Kit_hall, interactables, Tea House doors and lift) and the
// Tea House rect are never touched. The source GLB stays plain so the Python bridge passes (which skip instanced nodes) keep working,
// and split_lod keeps reading it (it drops instanced nodes from the far view).
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshGPUInstancing, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ALLOW = /^(Tree_packtree|Tree_real_|ls_tree|ls_path|SK_lantern|SK_med_)/;
const TEA = [-41, -88, -9, -69]; // same rect as build_tiles.sh --hero
const MIN = 4;

/** Rendered triangles per material name, instances counted (what verify_tiles compares). */
export function trisByMaterial(doc) {
  const m = new Map();
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh(); if (!mesh) continue;
    const ext = n.getExtension("EXT_mesh_gpu_instancing");
    const k = ext ? ext.listAttributes()[0].getCount() : 1;
    for (const p of mesh.listPrimitives()) {
      const t = ((p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3) * k;
      const key = p.getMaterial()?.getName() ?? "";
      m.set(key, (m.get(key) ?? 0) + t);
    }
  }
  return m;
}

export function instanceProps(doc) {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const groups = new Map();
  scene.traverse((n) => {
    const mesh = n.getMesh();
    if (!mesh || !ALLOW.test(n.getName()) || n.getSkin() || n.listChildren().length || n.getExtension("EXT_mesh_gpu_instancing")) return;
    const [x, , z] = n.getWorldTranslation();
    if (x >= TEA[0] && x <= TEA[2] && z >= TEA[1] && z <= TEA[3]) return;
    if (!groups.has(mesh)) groups.set(mesh, []);
    groups.get(mesh).push(n);
  });
  const ext = doc.createExtension(EXTMeshGPUInstancing);
  const buf = doc.getRoot().listBuffers()[0];
  let batches = 0, folded = 0;
  for (const [mesh, nodes] of groups) {
    if (nodes.length < MIN) continue;
    const T = new Float32Array(nodes.length * 3), R = new Float32Array(nodes.length * 4), S = new Float32Array(nodes.length * 3);
    nodes.forEach((n, i) => { T.set(n.getWorldTranslation(), i * 3); R.set(n.getWorldRotation(), i * 4); S.set(n.getWorldScale(), i * 3); });
    const acc = (arr, type) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
    const batch = ext.createInstancedMesh().setAttribute("TRANSLATION", acc(T, "VEC3")).setAttribute("ROTATION", acc(R, "VEC4")).setAttribute("SCALE", acc(S, "VEC3"));
    // the batch keeps the props' name stem, so a name-keyed probe or regex still sees what it is
    scene.addChild(doc.createNode(nodes[0].getName().replace(/[._]\d+$/, "") + "__inst").setMesh(mesh).setExtension("EXT_mesh_gpu_instancing", batch));
    for (const n of nodes) n.dispose();
    batches++; folded += nodes.length;
  }
  if (!batches) ext.dispose();
  return { batches, folded };
}

function sameTris(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? -1) - v) > 1e-6) return false;
  return true;
}

if (process.argv[2] === "--selftest") {
  const doc = new Document(); const buf = doc.createBuffer(); const scene = doc.createScene(); doc.getRoot().setDefaultScene(scene);
  const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
  const mat = doc.createMaterial("leaf");
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", pos).setMaterial(mat));
  const parent = doc.createNode("grp").setTranslation([100, 0, 0]); scene.addChild(parent);
  for (let i = 0; i < 5; i++) parent.addChild(doc.createNode(`Tree_packtree_a.${i}`).setMesh(mesh).setTranslation([i, 0, 0]));
  scene.addChild(doc.createNode("Tree_packtree_a.tea").setMesh(mesh).setTranslation([-20, 0, -80])); // inside the Tea rect: stays
  for (let i = 0; i < 6; i++) scene.addChild(doc.createNode(`Kit_hall_${i}`).setMesh(mesh)); // not allowlisted: stays
  const before = trisByMaterial(doc);
  const r = instanceProps(doc);
  const inst = doc.getRoot().listNodes().filter((n) => n.getExtension("EXT_mesh_gpu_instancing"));
  const t = inst[0]?.getExtension("EXT_mesh_gpu_instancing").getAttribute("TRANSLATION").getArray();
  const ok = r.batches === 1 && r.folded === 5 && inst[0].getName() === "Tree_packtree_a__inst" && t[0] === 100 && t[12] === 104 && sameTris(before, trisByMaterial(doc));
  console.log(ok ? "selftest PASS" : `selftest FAIL ${JSON.stringify(r)} ${t}`); process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  const [IN, OUT] = process.argv.slice(2);
  await MeshoptDecoder.ready; await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const doc = await io.read(IN);
  const before = trisByMaterial(doc);
  const r = instanceProps(doc);
  if (!sameTris(before, trisByMaterial(doc))) { console.error("instance_world: rendered triangles per material changed"); process.exit(1); }
  doc.getRoot().listExtensionsUsed().find((e) => e.extensionName === EXTMeshoptCompression.EXTENSION_NAME)?.dispose(); // temp copy: plain buffers
  await io.write(OUT, doc);
  console.log(`instance ${r.batches} batches, ${r.folded} props folded`);
}
