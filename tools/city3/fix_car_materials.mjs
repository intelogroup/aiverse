// car-npc.glb (tools/city3/lod_car.py output) renders with white wheels, roof and arch liners: the Blender export left emissiveFactor (1,1,1) on
// materials that are not lights (Mirror, Material_2, Hardware, Brake, Rim1, Rim2), and the paint is full metal, which reads muddy brown under the
// stage's RoomEnvironment at 0.6. Lights keep their glow (they carry KHR_materials_emissive_strength). Idempotent.
//   bun run tools/city3/fix_car_materials.mjs [apps/console/public/assets/car-npc.glb]
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
const file = process.argv[2] ?? "apps/console/public/assets/car-npc.glb";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === "EXT_meshopt_compression")) throw new Error("meshopt car: rewrite would change its encoding");
const log = [];
for (const m of doc.getRoot().listMaterials()) {
  const [r, g, b] = m.getEmissiveFactor();
  const isLight = m.listExtensions().some((e) => e.extensionName === "KHR_materials_emissive_strength");
  if (!isLight && !m.getEmissiveTexture() && Math.min(r, g, b) > 0.9) { m.setEmissiveFactor([0, 0, 0]); log.push(m.getName() + " emissive off"); }
  if (m.getName() === "Paint 1 Carmine" && m.getMetallicFactor() > 0.6) { m.setMetallicFactor(0.6).setRoughnessFactor(0.32); log.push("paint metal 0.6"); }
  if (m.getName() === "Tireside" && Math.min(...m.getBaseColorFactor().slice(0, 3)) > 0.9) { m.setBaseColorFactor([0.04, 0.04, 0.04, 1]); log.push("tyre wall dark"); }
}
if (log.length) await io.write(file, doc);
console.log(log.length ? log.join("; ") : "already fixed");
