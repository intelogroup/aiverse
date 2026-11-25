import * as THREE from "three";

// The original conversion put grayscale detail maps on these surfaces. Tint
// the existing maps and keep the estate's authored geometry and UVs.
const finishes: ReadonlyMap<string, { color: number; roughness: number; metalness: number }> = new Map([
  ["grass 01", { color: 0x6e8347, roughness: 0.96, metalness: 0 }],
  ["AM107_092_soil", { color: 0x716149, roughness: 0.95, metalness: 0 }],
  ["WALL::American C", { color: 0xded5c5, roughness: 0.82, metalness: 0 }],
  ["wall_065", { color: 0xc6b7a1, roughness: 0.88, metalness: 0 }],
  ["Material #214356", { color: 0xa59a88, roughness: 0.78, metalness: 0 }],
  ["Material #2147", { color: 0x876849, roughness: 0.57, metalness: 0.18 }],
  ["sidewalk", { color: 0xa99e8d, roughness: 0.92, metalness: 0 }],
  ["sidewalk1", { color: 0xa99e8d, roughness: 0.92, metalness: 0 }],
  ["Material #14", { color: 0x373a38, roughness: 0.75, metalness: 0 }],
  ["glass 01", { color: 0x57777c, roughness: 0.21, metalness: 0.28 }],
]);

export function cloneVillaScene(source: THREE.Object3D) {
  const clone = source.clone(true);
  const materials = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  function finish(mat: THREE.Material): THREE.Material {
    if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;

    const cached = materials.get(mat);
    if (cached) return cached;
    const copy = mat.clone();
    // Some of the converted shells only have one authored face.
    copy.side = THREE.DoubleSide;
    const chosen = finishes.get(copy.name);
    if (chosen) {
      copy.color.setHex(chosen.color);
      copy.roughness = chosen.roughness;
      copy.metalness = chosen.metalness;
      copy.roughnessMap = null;
      copy.metalnessMap = null;
    }
    if (copy.name === "glass 01") {
      // The model is an exterior shell. Opaque tinted glazing keeps the
      // interior mesh hidden while retaining a readable sky reflection.
      copy.emissive.setHex(0x64828a);
      copy.emissiveIntensity = 0.12;
    }
    materials.set(mat, copy);
    return copy;
  }
  clone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    object.material = Array.isArray(object.material) ? object.material.map(finish) : finish(object.material);
  });
  return clone;
}
