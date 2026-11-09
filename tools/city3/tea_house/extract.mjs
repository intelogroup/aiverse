// Recover the Tea House's spatial subset from the shipped, merged city GLB.
// No round trip through Blender; textures and material definitions are retained.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const THREE = await import(path.join(root, 'apps/console/node_modules/three/build/three.module.js'));
const { GLTFLoader } = await import(path.join(root, 'apps/console/node_modules/three/examples/jsm/loaders/GLTFLoader.js'));
const { MeshoptDecoder } = await import(path.join(root, 'apps/console/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'));
globalThis.ProgressEvent ??= class { constructor(type, fields) { Object.assign(this, fields); this.type = type; } };
const dest = path.resolve(process.argv[2] ?? path.join(root, 'docs/procedural-city/tea-house'));
fs.mkdirSync(dest, { recursive: true });
const input = path.join(root, 'apps/console/public/assets/world-city3.glb');
const src = fs.readFileSync(input);
const jsonLength = src.readUInt32LE(12);
const original = JSON.parse(src.toString('utf8', 20, 20 + jsonLength));
const binStart = 20 + jsonLength + 8;
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
// Image decoding is unnecessary for geometry extraction, and unavailable in Node.
loader.register(() => ({ name: 'surveyMaterials', loadMaterial: index => {
  const m = new THREE.MeshStandardMaterial(); m.userData.sourceMaterial = index; return Promise.resolve(m);
} }));
const model = await loader.parseAsync(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength), '');
model.scene.updateMatrixWorld(true);
const out = { asset: { version: '2.0', generator: 'AIVerse Tea House spatial survey' }, scene: 0,
  scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [], textures: [], images: [], samplers: original.samplers ?? [] };
let size = 0; const chunks = [];
function view(bytes) {
  const pad = (4 - size % 4) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); size += pad; }
  const i = out.bufferViews.length; out.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length }); chunks.push(bytes); size += bytes.length; return i;
}
function accessor(values, itemSize, integer = false) {
  const a = integer ? new Uint32Array(values) : new Float32Array(values);
  const item = { bufferView: view(Buffer.from(a.buffer)), componentType: integer ? 5125 : 5126, count: values.length / itemSize, type: ({ 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' })[itemSize] };
  if (itemSize === 3 && !integer) {
    item.min = [Infinity, Infinity, Infinity]; item.max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < values.length; k++) { const c = k % 3; item.min[c] = Math.min(item.min[c], values[k]); item.max[c] = Math.max(item.max[c], values[k]); }
  }
  out.accessors.push(item); return out.accessors.length - 1;
}
const matMap = new Map(), texMap = new Map(), imgMap = new Map();
function texture(i) {
  if (texMap.has(i)) return texMap.get(i);
  const t = structuredClone(original.textures[i]);
  if (!imgMap.has(t.source)) {
    const image = structuredClone(original.images[t.source]); const bv = original.bufferViews[image.bufferView];
    image.bufferView = view(src.subarray(binStart + (bv.byteOffset ?? 0), binStart + (bv.byteOffset ?? 0) + bv.byteLength));
    imgMap.set(t.source, out.images.length); out.images.push(image);
  }
  t.source = imgMap.get(t.source); texMap.set(i, out.textures.length); out.textures.push(t); return texMap.get(i);
}
function material(i) {
  if (matMap.has(i)) return matMap.get(i);
  const m = structuredClone(original.materials[i]);
  function visit(v) { for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object') { if (k.endsWith('Texture') && Number.isInteger(x.index)) x.index = texture(x.index); else visit(x); } }
  visit(m); matMap.set(i, out.materials.length); out.materials.push(m); return matMap.get(i);
}
const bounds = new THREE.Box3(), surveys = [];
// Exclude streets, landscaping, mobile props and furniture; include envelope detail.
const names = /^(B_Facade_ochre|InteriorWalls|WoodFloor|RoofTile|Shutters|Glass|Props|Signs|BladeSigns|Awnings|inst_door_)/;
const normalMatrix = new THREE.Matrix3(), point = new THREE.Vector3(), normal = new THREE.Vector3();
model.scene.traverse(o => {
  if (!o.isMesh || !names.test(o.name)) return;
  const transforms = [];
  if (o.isInstancedMesh) { for (let n = 0; n < o.count; n++) { const m = new THREE.Matrix4(); o.getMatrixAt(n, m); transforms.push(o.matrixWorld.clone().multiply(m)); } }
  else transforms.push(o.matrixWorld);
  const g = o.geometry, pos = g.attributes.position, idx = g.index;
  for (const matrix of transforms) {
    normalMatrix.getNormalMatrix(matrix);
    const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
    for (const group of groups) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const mi = mats[group.materialIndex]?.userData.sourceMaterial; if (mi === undefined) continue;
      const kept = [], remap = new Map(), attrs = {};
      const semantic = { position: 'POSITION', normal: 'NORMAL', uv: 'TEXCOORD_0', uv1: 'TEXCOORD_1', color: 'COLOR_0' };
      for (const [name, a] of Object.entries(g.attributes)) if (semantic[name]) attrs[name] = { a, values: [] };
      const verts = [];
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const ids = [0, 1, 2].map(k => idx ? idx.getX(i + k) : i + k);
        const ps = ids.map(v => new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(matrix));
        // Whole triangles, no geometric cutting of the original shell. Eave allowance 0.65 m.
        if (!ps.every(p => p.x >= -38.15 && p.x <= -11.85 && p.z >= -85.15 && p.z <= -71.85 && p.y >= .19 && p.y <= 22)) continue;
        const cx = ps.reduce((s, p) => s + p.x, 0) / 3, cz = ps.reduce((s, p) => s + p.z, 0) / 3;
        if (cx < -37.78 || cx > -12.22 || cz < -85.06 || cz > -72.0) continue;
        // Roof eaves run beyond the footprint; adjacent rose facades are excluded by name.
        for (const id of ids) {
          if (!remap.has(id)) {
            remap.set(id, remap.size);
            for (const [name, { a, values }] of Object.entries(attrs)) {
              if (name === 'position') { point.fromBufferAttribute(a, id).applyMatrix4(matrix); bounds.expandByPoint(point); point.x += 37.5; point.z += 72.5; values.push(...point.toArray()); verts.push(...point.toArray()); }
              else if (name === 'normal') { normal.fromBufferAttribute(a, id).applyNormalMatrix(normalMatrix); values.push(...normal.toArray()); }
              else for (let c = 0; c < a.itemSize; c++) values.push(a.getComponent(id, c));
            }
          }
          kept.push(remap.get(id));
        }
      }
      if (!kept.length) continue;
      const attributes = {};
      for (const [name, { a, values }] of Object.entries(attrs)) attributes[semantic[name]] = accessor(values, a.itemSize);
      const primitive = { attributes, indices: accessor(kept, 1, true), material: material(mi) };
      const n = out.nodes.length; out.scenes[0].nodes.push(n); out.nodes.push({ name: `${o.name}_${n}`, mesh: out.meshes.length }); out.meshes.push({ primitives: [primitive] });
      surveys.push({ name: o.name, material: original.materials[mi].name, triangles: kept.length / 3, minY: Math.min(...verts.filter((_, k) => k % 3 === 1)), maxY: Math.max(...verts.filter((_, k) => k % 3 === 1)) });
    }
  }
});
out.buffers.push({ byteLength: size });
out.extensionsUsed = (original.extensionsUsed ?? []).filter(x => !['EXT_meshopt_compression', 'EXT_mesh_gpu_instancing'].includes(x));
const meta = { source: 'apps/console/public/assets/world-city3.glb', sha256: crypto.createHash('sha256').update(src).digest('hex'),
  footprint: [-37.5, -84.5, -12.5, -72.5], lot: 'shop-102', floorsFromRecipe: 4,
  method: 'Whole-triangle spatial subset of merged city mesh, envelope nodes only; includes shared boundary faces. No inferred upper slabs.',
  localFrame: 'glTF X = worldX + 37.5; Y unchanged; Z = worldZ + 72.5; street front Z=0, rear Z=-12',
  worldBounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, triangles: surveys.reduce((s, x) => s + x.triangles, 0), meshes: surveys };
out.extras = { survey: meta.method, lot: 'shop-102' };
let js = Buffer.from(JSON.stringify(out)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 32)]);
let bin = Buffer.concat(chunks); bin = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + js.length + bin.length, 8);
jh.writeUInt32LE(js.length); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(bin.length); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(path.join(dest, 'existing-shell.glb'), Buffer.concat([header, jh, js, bh, bin]));
fs.writeFileSync(path.join(dest, 'survey.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(JSON.stringify(meta, null, 2));
