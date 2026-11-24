import * as THREE from "three";

/**
 * Treatments applied to loaded district GLB trees: full disposal on eviction, the theme's night
 * emissive scaling, and hiding the legacy water/sea surfaces the ocean plane replaces. Pure
 * functions of the tree — no component state — shared by every load path in DistrictWorld
 * (resident, links, far shell, far LOD, streamed districts, collision GLBs).
 */
export const disposeTree = (root: THREE.Object3D) =>
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry.boundsTree) m.geometry.disposeBoundsTree();
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });

const EMISSIVE: Record<string, number> = { glass: 1.5, msign: 0.9, led: 1.0 };
/** Scale emissive windows/signs/LEDs by the theme's `night`; the base intensity is remembered on the material. */
export function applyNight(root: THREE.Object3D, night: number) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const std = mat as THREE.MeshStandardMaterial;
      const k = EMISSIVE[std.name];
      if (k === undefined || !std.emissive) continue;
      std.userData.baseEmissive ??= std.emissiveIntensity || 1;
      std.emissiveIntensity = std.userData.baseEmissive * (std.name === "led" ? 0.15 + night * k : night * k);
    }
  });
}

const MAPS = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"] as const;
/** Anisotropic filtering on every texture of a root: without it lawns, roads and paving smear into streaks at the grazing angles a walker sees. */
export function sharpenTextures(root: THREE.Object3D, anisotropy: number) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const k of MAPS) {
        const t = (mat as unknown as Record<string, THREE.Texture | null>)[k];
        if (t && t.anisotropy < anisotropy) { t.anisotropy = anisotropy; t.needsUpdate = true; }
      }
    }
  });
}

// Water and sea surfaces are replaced by the ocean + FountainWater below, in every root (the resident does the same in its effect).
export const hideLegacyWater = (root: THREE.Object3D) => root.traverse((o) => {
  const m = o as THREE.Mesh; if (!m.isMesh) return;
  if ((Array.isArray(m.material) ? m.material : [m.material]).some((mat) => mat.name === "water" || mat.name === "sea")) m.visible = false;
});
