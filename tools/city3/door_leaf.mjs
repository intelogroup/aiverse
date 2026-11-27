#!/usr/bin/env bun
// Lift a door leaf (a sliding pane, a shoji panel) out of a placed house GLB as its own leaf GLB, for houseDoor.ts.
//   bun tools/city3/door_leaf.mjs HOUSE.glb x0,x1,y0,y1,z0,z1 FRONT BASE_Y OUT_DIR [--remove]
// The box is in the GLB's own (lot-local) frame; a triangle goes to the leaf when all three corners sit inside it. FRONT (+x|-x|+z|-z)
// is the way the door faces the street in that frame. The leaf is written in the door frame houseDoor.ts expects: its left jamb (seen
// from the street) at x 0, y 0 at BASE_Y (the walk floor at the sill), slab middle at z 0. OUT_DIR/leaf.json carries its size, the
// frame's yaw and the leaf centre in the GLB frame. --remove also cuts those triangles out of HOUSE.glb in place (one shared GLB per
// model and yaw, so every lot of it loses the pane); without it the leaf is a copy (a fixed shoji panel reused as the sliding one).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { compactPrimitive, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { mkdirSync, writeFileSync } from "node:fs";

const [house, boxArg, front, baseArg, out] = process.argv.slice(2);
const remove = process.argv.includes("--remove");
const YAW = { "+z": 0, "+x": 90, "-z": 180, "-x": 270 }[front];
if (!out || YAW === undefined) throw new Error("usage: door_leaf.mjs HOUSE.glb x0,x1,y0,y1,z0,z1 +x|-x|+z|-z BASE_Y OUT_DIR [--remove]");
const box = boxArg.split(",").map(Number), baseY = Number(baseArg);
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

// door axes in the GLB frame (same yaw convention as houseDoor.ts): local +x along the opening, local +z out to the street
const t = (YAW * Math.PI) / 180, X = [Math.cos(t), -Math.sin(t)], F = [Math.sin(t), Math.cos(t)];
const world = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const inBox = (p) => p[0] >= box[0] && p[0] <= box[1] && p[1] >= box[2] && p[1] <= box[3] && p[2] >= box[4] && p[2] <= box[5];

/** Keep, in every primitive of `doc`, the triangles `want(inside)` picks; drop emptied primitives. Returns the kept leaf-side corners. */
function keep(doc, want) {
  const corners = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION"), idx = prim.getIndices(), n = idx ? idx.getCount() : pos.getCount(), v = [0, 0, 0], kept = [];
      for (let i = 0; i < n; i += 3) {
        const tri = [0, 1, 2].map((j) => idx ? idx.getScalar(i + j) : i + j);
        const ps = tri.map((k) => world(m, pos.getElement(k, v)));
        const inside = ps.every(inBox);
        if (want(inside)) { kept.push(...tri); if (inside) corners.push(...ps); }
      }
      if (kept.length === n) continue;
      if (!kept.length) { prim.dispose(); continue; }
      prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(kept)).setBuffer(doc.getRoot().listBuffers()[0]));
      compactPrimitive(prim);
    }
    if (!mesh.listPrimitives().length) { node.setMesh(null); mesh.dispose(); }
  }
  return corners;
}

const leafDoc = await io.read(house);
const corners = keep(leafDoc, (inside) => inside);
if (!corners.length) throw new Error("no triangles inside the box");
const along = corners.map((p) => X[0] * p[0] + X[1] * p[2]), out_ = corners.map((p) => F[0] * p[0] + F[1] * p[2]);
const x0 = Math.min(...along), x1 = Math.max(...along), f0 = Math.min(...out_), f1 = Math.max(...out_), fm = (f0 + f1) / 2;
const top = Math.max(...corners.map((p) => p[1]));
// one root node maps the GLB frame to the door frame: rows are local x, y, z (a pure rotation plus offsets)
const scene = leafDoc.getRoot().getDefaultScene() ?? leafDoc.getRoot().listScenes()[0];
const frame = leafDoc.createNode("door-frame").setMatrix([X[0], 0, F[0], 0, 0, 1, 0, 0, X[1], 0, F[1], 0, -x0, -baseY, -fm, 1]);
for (const child of scene.listChildren()) { scene.removeChild(child); frame.addChild(child); }
scene.addChild(frame);
await leafDoc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: "high" }));
mkdirSync(out, { recursive: true });
await io.write(`${out}/leaf.glb`, leafDoc);
const r3 = (v) => +v.toFixed(3), cx = (x0 + x1) / 2;
const info = { width: r3(x1 - x0), height: r3(top - baseY), thick: r3(f1 - f0), yaw: YAW, centre: [r3(X[0] * cx + F[0] * fm), r3(X[1] * cx + F[1] * fm)], baseY, triangles: corners.length / 3 };
writeFileSync(`${out}/leaf.json`, JSON.stringify(info));
console.log("leaf", JSON.stringify(info));

if (remove) {
  const houseDoc = await io.read(house);
  keep(houseDoc, (inside) => !inside);
  await houseDoc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: "high" }));
  await io.write(house, houseDoc);
  console.log("house: cut", corners.length / 3, "triangles");
}
