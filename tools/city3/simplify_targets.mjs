/**
 * Stage A of the bazaar decimation: compute simplified index arrays for named over-detailed
 * meshes and emit them as JSON. Writes nothing to the GLB.
 *
 * Splitting it this way is deliberate. Re-encoding the whole file through gltf-transform's
 * meshopt() transform would re-quantise POSITION (MeshoptOptions extends QuantizeOptions with
 * no opt-out), which is the 12-bit shared-exponent problem docs/procedural-city/06-failures-log.md
 * #9 records as 4 cm rugs/signs snapping onto surfaces. Here the vertices are never rewritten:
 * MeshoptSimplifier.simplify() returns indices that reference the existing vertex array, and
 * apply_indices.py appends them as raw views, the same trick bridge_bones.py/bridge_compact.py
 * use.
 *
 *   bun tools/city3/simplify_targets.mjs apps/console/public/assets/world-city3.glb > /tmp/bath.json
 *   python3 tools/city3/apply_indices.py <in.glb> <out.glb> /tmp/bath.json
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";

const SRC = process.argv[2];
// mesh name -> fraction of triangles to keep
const TARGETS = {
  "bathroom-sink_body": 0.031,   // 13116 -> ~410
  "toilet_body": 0.040,          //  7980 -> ~320
  "toilet_seat": 0.031,          //  3888 -> ~120
  "toilet_lid": 0.046,           //  2160 -> ~100
  "bathroom-sink_mirror": 0.073, //  2752 -> ~200
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
await Promise.all([MeshoptDecoder.ready, MeshoptSimplifier.ready]);

const doc = await io.read(SRC);
const out = [];
for (const mesh of doc.getRoot().listMeshes()) {
  const ratio = TARGETS[mesh.getName()];
  if (ratio === undefined) continue;
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    const pos = prim.getAttribute("POSITION");
    if (!idx || !pos) continue;
    const src = Uint32Array.from(idx.getArray());
    const positions = Float32Array.from(pos.getArray());
    const target = Math.max(3, Math.floor(src.length * ratio / 3) * 3);
    let ni;
    try {
      [ni] = MeshoptSimplifier.simplify(src, positions, 3, target, 0.02, ["Permissive"]);
    } catch (e) {
      console.error(`${mesh.getName()}: simplify failed: ${e.message}`);
      continue;
    }
    if (!ni || ni.length === 0 || ni.length >= src.length) {
      console.error(`${mesh.getName()}: no reduction (${src.length / 3} tris)`);
      continue;
    }
    // vertices are untouched, so the new indices must stay inside the existing vertex array
    let maxIdx = 0;
    for (const i of ni) if (i > maxIdx) maxIdx = i;
    if (maxIdx >= pos.getCount()) throw new Error(`${mesh.getName()}: index ${maxIdx} out of range`);

    out.push({
      mesh: mesh.getName(),
      primitives: mesh.listPrimitives().indexOf(prim),
      triangles_before: src.length / 3,
      triangles_after: ni.length / 3,
      indices: Array.from(ni),
    });
  }
}
console.error(`targets hit: ${out.length}; saved ${out.reduce((a, o) => a + o.triangles_before - o.triangles_after, 0)} tris`);
process.stdout.write(JSON.stringify(out));
