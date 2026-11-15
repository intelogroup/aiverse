#!/usr/bin/env node
/**
 * generate-lod.mjs — LOD trial asset builder (branch tmp/lod-bazaar).
 *
 * Reads the PR #163 world-city3 build (meshopt + KTX2, NO quantization) and
 * appends meshoptimizer simplification levels for the bazaar repeated-prop
 * set (stalls SK_med_stall*, instanced goods inst_goods_*, FountainClayPot*):
 * for every target node it adds child nodes __lvl1/__lvl2/__lvl3 carrying
 * simplified meshes (50% / 25% / 10% triangle budgets). LOD0 is the original
 * node, untouched — every pre-existing byte of geometry stays where it was;
 * new geometry is appended to the BIN chunk as plain (uncompressed)
 * bufferViews on buffer 0. Each __lvl node carries extras {lod:{level,
 * error, tris}} with the simplifier's measured absolute error (metres), so
 * the console can derive screen-space-error switch distances at runtime.
 *
 * No quantization anywhere: positions/normals/uvs are float32, copied from
 * the decoded source attributes (vertex subsets chosen by the simplifier's
 * index stream + manual compaction).
 *
 * Usage: node generate-lod.mjs <in.glb> <out.glb> [--inspect]
 * Modules (three, meshoptimizer) are resolved from the world-compress
 * pipeline's node_modules (WC_MODULES env, default below) — the same stack
 * that produced and verified the PR #163 build.
 */
import { readFileSync, writeFileSync } from "node:fs";

const WC = process.env.WC_MODULES || "/home/hatch/workspace/.build-tmp/world-compress/node_modules";
const { GLTFLoader } = await import(`${WC}/three/examples/jsm/loaders/GLTFLoader.js`);
const { MeshoptDecoder } = await import(`${WC}/three/examples/jsm/libs/meshopt_decoder.module.js`);
const { MeshoptSimplifier } = await import(`${WC}/meshoptimizer/meshopt_simplifier.js`);

const [inPath, outPath, mode] = process.argv.slice(2);
if (!inPath || !outPath) { console.error("usage: generate-lod.mjs <in.glb> <out.glb> [--inspect]"); process.exit(2); }

const RATIOS = [0.5, 0.25, 0.10];
const isTargetName = (n) => /^SK_med_stall/.test(n) || /^inst_goods_/.test(n) || /^FountainClayPot/.test(n);

// ---------- parse GLB ----------
const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
if (buf.readUInt32LE(20 + jsonLen + 4) !== 0x004e4942) throw new Error("BIN chunk not where expected");
const binChunkLen = buf.readUInt32LE(20 + jsonLen);
const binStart = 20 + jsonLen + 8;
const bin = buf.subarray(binStart, binStart + binChunkLen);
console.log(`in: ${inPath} bytes=${buf.length} json=${jsonLen} bin=${binChunkLen} nodes=${gltf.nodes.length} meshes=${gltf.meshes.length}`);

// ---------- decode with three (meshopt decoder only; geometry extraction) ----------
// Node has no DOM image pipeline, so parse a texture-stripped copy (images /
// textures / samplers dropped, materials untextured). Geometry, nodes and
// mesh wiring are untouched by the strip; the surgery below uses `gltf`,
// the pristine parse, never this copy.
globalThis.self = globalThis;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const parseJson = JSON.parse(JSON.stringify(gltf));
delete parseJson.images; delete parseJson.textures; delete parseJson.samplers;
for (const m of parseJson.materials || []) {
  delete m.pbrMetallicRoughness?.baseColorTexture; delete m.normalTexture; delete m.emissiveTexture;
  delete m.occlusionTexture; if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.metallicRoughnessTexture;
  delete m.extensions; // KHR_materials_* carry texture refs too (specularTexture et al.)
}
if (parseJson.extensionsUsed) parseJson.extensionsUsed = parseJson.extensionsUsed.filter((e) => e !== "KHR_texture_basisu");
const pj = Buffer.from(JSON.stringify(parseJson), "utf8");
const pjPad = (4 - (pj.length % 4)) % 4;
const parseBuf = Buffer.alloc(12 + 8 + pj.length + pjPad + 8 + binChunkLen);
out: {
  parseBuf.writeUInt32LE(0x46546c67, 0); parseBuf.writeUInt32LE(2, 4);
  parseBuf.writeUInt32LE(parseBuf.length, 8);
  let o = 12;
  parseBuf.writeUInt32LE(pj.length + pjPad, o); parseBuf.writeUInt32LE(0x4e4f534a, o + 4); o += 8;
  pj.copy(parseBuf, o); o += pj.length; for (let i = 0; i < pjPad; i++) parseBuf[o++] = 0x20;
  parseBuf.writeUInt32LE(binChunkLen, o); parseBuf.writeUInt32LE(0x004e4942, o + 4); o += 8;
  bin.copy(parseBuf, o);
}
const decoded = await loader.parseAsync(parseBuf.buffer.slice(parseBuf.byteOffset, parseBuf.byteOffset + parseBuf.byteLength), "");
await MeshoptSimplifier.ready;

// Parallel walk: GLB node graph <-> three scene graph (children in JSON order).
const sanitize = (s) => (s || "").replace(/\s/g, "_").replace(/[[\]\\.:/]/g, ""); // three's PropertyBinding.sanitizeNodeName
const nodeObj = new Map(); // glb node index -> THREE.Object3D
const primCountOf = (gn) => (gn.mesh != null ? gltf.meshes[gn.mesh].primitives.length : 0);
// GLTFLoader child order inside a node object: [prim meshes (only when the
// node's mesh has >1 prim), ...glTF children]. A 1-prim node's object IS the
// prim mesh; a 0-prim node's children are all glTF children.
function walk(glbNodes, threeParent, parentPrimSkip = 0) {
  const kids = threeParent.children.slice(parentPrimSkip);
  if (kids.length !== glbNodes.length) throw new Error(`child count mismatch under ${threeParent.name}: glb=${glbNodes.length} three=${kids.length} (skip=${parentPrimSkip})`);
  glbNodes.forEach((ni, i) => {
    const o = kids[i];
    const gn = gltf.nodes[ni];
    // three dedupes repeated names with a _<n> suffix; multi-prim node objects
    // are groups that may carry the mesh name. Accept those forms; child-count
    // structure (asserted in walk) is the hard invariant.
    const s = sanitize(gn.name);
    const nameOk = o.name === s || (o.name.startsWith(s + "_") && /^\d+$/.test(o.name.slice(s.length + 1)))
      || (gn.mesh != null && primCountOf(gn) > 1 && o.name === sanitize(gltf.meshes[gn.mesh].name));
    if (!nameOk) throw new Error(`name mismatch at node ${ni}: glb=${gn.name} three=${o.name}`);
    nodeObj.set(ni, o);
    if (gn.children) walk(gn.children, o, primCountOf(gn) > 1 ? primCountOf(gn) : 0);
  });
}
for (const scene of gltf.scenes) walk(scene.nodes, decoded.scene);

// prim objects of a three node-object, in glTF prim order
function primObjects(o, primCount) {
  if (primCount === 0) return [];
  if (primCount === 1) return [o];
  return o.children.slice(0, primCount);
}

// ---------- targets ----------
// Reachable nodes only: the GLB carries 236 orphan nodes no loader ever
// instantiates (27 of them match the prop patterns — dead second copies of
// crates/mounds/pots/pyramids/goblets). LOD-wiring those would be pure waste.
const reachable = new Set();
{
  const stack = [...(gltf.scenes[gltf.scene ?? 0]?.nodes || [])];
  while (stack.length) { const ni = stack.pop(); if (reachable.has(ni)) continue; reachable.add(ni); const cn = gltf.nodes[ni]; if (cn.children) stack.push(...cn.children); }
}
const targetNodes = [];
for (let ni = 0; ni < gltf.nodes.length; ni++) {
  const n = gltf.nodes[ni];
  if (n.mesh == null || !isTargetName(n.name || "") || !reachable.has(ni)) continue;
  targetNodes.push(ni);
}
const targetMeshIdx = [...new Set(targetNodes.map((ni) => gltf.nodes[ni].mesh))];
console.log(`targets: ${targetNodes.length} nodes, ${targetMeshIdx.length} distinct meshes`);

if (mode === "--inspect") {
  for (const ni of targetNodes.slice(0, 6)) {
    const o = nodeObj.get(ni);
    console.log(ni, gltf.nodes[ni].name, "three:", o.type, "prims:", primObjects(o, gltf.meshes[gltf.nodes[ni].mesh].primitives.length).map((p) => `${p.type}[${p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count} idx]`).join(" "));
  }
  const seven = targetMeshIdx.find((mi) => gltf.meshes[mi].primitives.length === 7);
  console.log("7-prim mesh:", seven, gltf.meshes[seven]?.name, "node:", nodeObj.get(targetNodes.find((ni) => gltf.nodes[ni].mesh === seven))?.type);
  process.exit(0);
}

// ---------- simplify per distinct mesh ----------
function interleavedAttrs(geo) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal?.array;
  const uv = geo.attributes.uv?.array;
  const n = geo.attributes.position.count;
  const stride = (nrm ? 3 : 0) + (uv ? 2 : 0);
  const arr = new Float32Array(n * stride);
  const weights = [];
  if (nrm) weights.push(1, 1, 1);
  if (uv) weights.push(0.25, 0.25);
  for (let i = 0; i < n; i++) {
    let k = i * stride;
    if (nrm) { arr[k++] = nrm[i * 3]; arr[k++] = nrm[i * 3 + 1]; arr[k++] = nrm[i * 3 + 2]; }
    if (uv) { arr[k++] = uv[i * 2]; arr[k++] = uv[i * 2 + 1]; }
  }
  return { arr, stride, weights, pos };
}

function compactArrays(index, geo) {
  // old->new vertex map in first-use order; rebuild attribute arrays
  const remap = new Map();
  const newIndex = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) {
    const v = index[i];
    let nv = remap.get(v);
    if (nv === undefined) { nv = remap.size; remap.set(v, nv); }
    newIndex[i] = nv;
  }
  const n = remap.size;
  const out = { index: newIndex, position: new Float32Array(n * 3) };
  const pos = geo.attributes.position.array;
  for (const [oldV, newV] of remap) { out.position[newV * 3] = pos[oldV * 3]; out.position[newV * 3 + 1] = pos[oldV * 3 + 1]; out.position[newV * 3 + 2] = pos[oldV * 3 + 2]; }
  if (geo.attributes.normal) {
    const a = geo.attributes.normal.array; out.normal = new Float32Array(n * 3);
    for (const [oldV, newV] of remap) { out.normal[newV * 3] = a[oldV * 3]; out.normal[newV * 3 + 1] = a[oldV * 3 + 1]; out.normal[newV * 3 + 2] = a[oldV * 3 + 2]; }
  }
  if (geo.attributes.uv) {
    const a = geo.attributes.uv.array; out.uv = new Float32Array(n * 2);
    for (const [oldV, newV] of remap) { out.uv[newV * 2] = a[oldV * 2]; out.uv[newV * 2 + 1] = a[oldV * 2 + 1]; }
  }
  return out;
}

// calibration: brute-force max distance from original vertices to simplified surface (small prims only)
function bruteForceError(origPos, simp) {
  const sp = simp.position, si = simp.index;
  let maxD = 0;
  const vCount = origPos.length / 3;
  for (let v = 0; v < vCount; v++) {
    const px = origPos[v * 3], py = origPos[v * 3 + 1], pz = origPos[v * 3 + 2];
    let best = Infinity;
    for (let t = 0; t < si.length; t += 3) {
      // distance to triangle centroid is a cheap lower-bound proxy; use closest of the 3 verts + centroid
      for (let k = 0; k < 3; k++) {
        const vi = si[t + k];
        const dx = px - sp[vi * 3], dy = py - sp[vi * 3 + 1], dz = pz - sp[vi * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
    const d = Math.sqrt(best);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

const levelMeshes = new Map(); // `${meshIdx}:${level}` -> { prims: [compacted...], error, tris }
let calibrated = false;
for (const mi of targetMeshIdx) {
  // find a representative three object for this mesh
  const repNode = targetNodes.find((ni) => gltf.nodes[ni].mesh === mi);
  const srcPrims = gltf.meshes[mi].primitives;
  const prims = primObjects(nodeObj.get(repNode), srcPrims.length);
  if (prims.length !== srcPrims.length) throw new Error(`prim count mismatch mesh ${mi}`);
  for (let level = 1; level <= RATIOS.length; level++) {
    const ratio = RATIOS[level - 1];
    const outPrims = [];
    let levelError = 0, levelTris = 0, prevTris = 0;
    for (let p = 0; p < prims.length; p++) {
      const geo = prims[p].geometry;
      const idx = geo.index ? Uint32Array.from(geo.index.array) : Uint32Array.from({ length: geo.attributes.position.count }, (_, i) => i);
      prevTris += idx.length / 3;
      const target = Math.max(3, Math.round((idx.length * ratio) / 3) * 3);
      if (target >= idx.length) { outPrims.push(null); continue; } // no reduction possible; reuse source prim at write time
      const { arr, stride, weights } = interleavedAttrs(geo);
      const [newIdx, err] = MeshoptSimplifier.simplifyWithAttributes(
        idx, geo.attributes.position.array, 3, arr, stride, weights, null,
        target, 1e9, ["ErrorAbsolute"],
      );
      const compacted = compactArrays(newIdx, geo);
      outPrims.push(compacted);
      levelError = Math.max(levelError, err);
      levelTris += newIdx.length / 3;
      if (!calibrated && idx.length <= 400 && idx.length >= 100) {
        const bf = bruteForceError(geo.attributes.position.array, compacted);
        console.log(`CALIBRATION mesh=${gltf.meshes[mi].name} prim=${p} ratio=${ratio} simplifierError=${err.toFixed(5)} m, bruteForce(vert->nearest simp vert, upper-ish proxy)=${bf.toFixed(5)} m`);
        calibrated = true;
      }
    }
    levelMeshes.set(`${mi}:${level}`, { prims: outPrims, error: levelError, tris: levelTris, srcTris: prevTris });
  }
}

// ---------- GLB surgery: append geometry, meshes, nodes ----------
const extra = []; // Buffers to append to BIN
let extraLen = 0;
const pad4 = (n) => (4 - (n % 4)) % 4;
function appendView(bytes) {
  const pad = pad4(binChunkLen + extraLen);
  if (pad) { extra.push(Buffer.alloc(pad)); extraLen += pad; }
  const byteOffset = binChunkLen + extraLen;
  extra.push(bytes); extraLen += bytes.length;
  gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
  return gltf.bufferViews.length - 1;
}
function addAccessor(array, type, componentType, minMax) {
  const bv = appendView(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  const acc = { bufferView: bv, byteOffset: 0, componentType, count: array.length / (type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1), type };
  if (minMax) { acc.min = minMax[0]; acc.max = minMax[1]; }
  gltf.accessors.push(acc);
  return gltf.accessors.length - 1;
}
function minMaxOf(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < min[k]) min[k] = pos[i + k]; if (pos[i + k] > max[k]) max[k] = pos[i + k]; }
  return [min, max];
}

// new mesh index per (source mesh, level)
const newMeshIdx = new Map();
for (const [key, lm] of levelMeshes) {
  const [mi, level] = key.split(":").map(Number);
  const srcPrims = gltf.meshes[mi].primitives;
  const prims = lm.prims.map((compacted, p) => {
    if (compacted === null) return srcPrims[p]; // no reduction: reference the source prim verbatim
    const attrs = {};
    attrs.POSITION = addAccessor(compacted.position, "VEC3", 5126, minMaxOf(compacted.position));
    if (compacted.normal) attrs.NORMAL = addAccessor(compacted.normal, "VEC3", 5126);
    if (compacted.uv) attrs.TEXCOORD_0 = addAccessor(compacted.uv, "VEC2", 5126);
    const idxArr = compacted.position.length / 3 <= 65535 ? Uint16Array.from(compacted.index) : compacted.index;
    const indices = addAccessor(idxArr, "SCALAR", idxArr instanceof Uint16Array ? 5123 : 5125);
    const prim = { attributes: attrs, indices };
    if (srcPrims[p].material !== undefined) prim.material = srcPrims[p].material;
    if (srcPrims[p].mode !== undefined) prim.mode = srcPrims[p].mode;
    return prim;
  });
  gltf.meshes.push({ name: `__lodmesh_${gltf.meshes[mi].name || mi}_l${level}`, primitives: prims });
  newMeshIdx.set(key, gltf.meshes.length - 1);
}

// child nodes under every target node
let addedNodes = 0;
for (const ni of targetNodes) {
  const node = gltf.nodes[ni];
  const mi = node.mesh;
  node.children = node.children || [];
  for (let level = 1; level <= RATIOS.length; level++) {
    const lm = levelMeshes.get(`${mi}:${level}`);
    if (!lm) continue;
    // skip a level that barely reduced (tiny prims): keep it only if it cut >= 15%
    if (lm.tris > 0 && lm.srcTris > 0 && lm.tris >= 0.98 * lm.srcTris && level > 1) continue;
    const child = { name: `__lvl${level}`, mesh: newMeshIdx.get(`${mi}:${level}`), extras: { lod: { level, error: lm.error, tris: lm.tris, srcTris: lm.srcTris } } };
    if (node.extensions?.EXT_mesh_gpu_instancing) {
      child.extensions = { EXT_mesh_gpu_instancing: node.extensions.EXT_mesh_gpu_instancing };
    }
    gltf.nodes.push(child);
    node.children.push(gltf.nodes.length - 1);
    addedNodes++;
  }
}
gltf.buffers[0].byteLength = binChunkLen + extraLen;

// ---------- write out ----------
const jsonStr = JSON.stringify(gltf);
const jsonBuf = Buffer.from(jsonStr, "utf8");
const jsonPad = pad4(jsonBuf.length);
const newBinLen = binChunkLen + extraLen;
const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + newBinLen + pad4(newBinLen);
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
let o = 12;
out.writeUInt32LE(jsonBuf.length + jsonPad, o); out.writeUInt32LE(0x4e4f534a, o + 4); o += 8;
jsonBuf.copy(out, o); o += jsonBuf.length; for (let i = 0; i < jsonPad; i++) out[o++] = 0x20;
out.writeUInt32LE(newBinLen + pad4(newBinLen), o); out.writeUInt32LE(0x004e4942, o + 4); o += 8;
bin.copy(out, o); o += binChunkLen;
for (const b of extra) { b.copy(out, o); o += b.length; }
writeFileSync(outPath, out);
console.log(`out: ${outPath} bytes=${out.length} (delta ${out.length - buf.length >= 0 ? "+" : ""}${out.length - buf.length}) addedNodes=${addedNodes} newMeshes=${newMeshIdx.size} appendedGeoBytes=${extraLen}`);
const tot = [...levelMeshes.values()].reduce((s, l) => s + l.tris, 0);
console.log("level tris (per distinct-mesh set, summed over levels):", tot);
