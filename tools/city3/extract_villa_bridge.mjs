// Keep the south span from the original four-span links GLB.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";
import { subset } from "./tile_grid.mjs";

const assets = "apps/console/public/assets";
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(`${assets}/world-links.glb`);
doc.getRoot().listExtensionsUsed().find(extension => extension.extensionName === "EXT_meshopt_compression")?.dispose();
for (const mesh of doc.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION").getArray();
    const indices = primitive.getIndices()?.getArray();
    const count = indices?.length ?? position.length / 3;
    const keep = [];
    for (let i = 0; i < count; i += 3) {
      const z = [i, i + 1, i + 2].map(vertex => position[(indices?.[vertex] ?? vertex) * 3 + 2]);
      if (Math.min(...z) > 170) keep.push(i / 3);
    }
    if (keep.length) subset(doc, primitive, keep);
    else primitive.dispose();
  }
}
await doc.transform(prune());
await io.write(`${assets}/villa-bridge.glb`, doc);
