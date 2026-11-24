// The stage environment, key light and shadow tagging (extracted
// from GlbWorld.tsx, cleanup L2).
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { assetUrl } from "../../lib/assetUrl";
import { qualityStore, shadowMapForTier } from "./quality";
import { CITY3_CENTER } from "./glbConstants";

export const SKY_HDRI_URL = "/assets/env/sky_1k.hdr";

/**
 * Environment for the stage. City 3 uses three's built-in
 * RoomEnvironment: with no environment at all, AgX + the single key
 * light washed the district foliage pale (the districts' palette data
 * was intact in the GLBs). DistrictWorld drives
 * scene.environmentIntensity from the blended theme's envIntensity, so
 * the 0.6 set here is only the pre-first-tick value.
 */
export function StageEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    // Matched tone-curve pair with the Blender authoring (AgX view transform):
    // R3F otherwise defaults to ACES Filmic, which grades the stage on a
    // different curve than the one it was authored under.
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = 1.1;
    // RoomEnvironment (an indoor studio) until the outdoor sky arrives: Poly Haven's CC0 "Kloofendal 48d Partly Cloudy (Pure Sky)",
    // 1k. Facades, glass and foliage then take their fill and reflections from a sky, not from studio panels.
    let envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;
    scene.environmentIntensity = 0.6;
    let live = true;
    new RGBELoader().load(assetUrl(SKY_HDRI_URL), (hdr) => {
      if (!live) { hdr.dispose(); return; }
      const sky = pmrem.fromEquirectangular(hdr).texture; hdr.dispose();
      envMap.dispose(); envMap = sky; scene.environment = sky;
    }, undefined, () => { /* keep the studio fallback */ });
    return () => {
      live = false;
      scene.environment = null;
      envMap.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * The stage's one shadow-casting key light, its ortho shadow camera
 * fitted to City 3's span. The target is added to the scene graph
 * explicitly — three only tracks a light's aim if the target's
 * matrixWorld updates.
 */
export function KeyLight({ lightRef }: { lightRef?: React.RefObject<THREE.DirectionalLight | null> }) {
  const ownRef = useRef<THREE.DirectionalLight>(null!);
  const light = (lightRef ?? ownRef) as React.RefObject<THREE.DirectionalLight>;
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const l = light.current;
    l.target.position.set(CITY3_CENTER[0], 0, CITY3_CENTER[1]);
    scene.add(l.target);
    l.target.updateMatrixWorld();
    return () => {
      l.target.removeFromParent();
    };
  }, [scene]);
  // Mobile Phase 3: the tier sizes the shadow map (never kills it: see
  // shadowMapForTier). The
  // store only moves on the touch path, so desktop reads "full"
  // forever — 2048 and casting, exactly as before. The key remounts
  // the light when the map size changes (three will not realloc a
  // live shadow map).
  const quality = useSyncExternalStore(qualityStore.subscribe, qualityStore.getSnapshot);
  const shadowMap = shadowMapForTier(quality.tier);
  return (
    <directionalLight
      key={shadowMap}
      ref={light}
      castShadow
      position={[120, 220, 90]}
      intensity={2.6}
      shadow-mapSize-width={Math.max(shadowMap, 1)}
      shadow-mapSize-height={Math.max(shadowMap, 1)}
      shadow-camera-left={-220}
      shadow-camera-right={220}
      shadow-camera-top={220}
      shadow-camera-bottom={-220}
      shadow-camera-near={10}
      shadow-camera-far={800}
      shadow-bias={-0.0004}
      // City 3 spans 440 m of shadow frustum on one map: its flat roofs and
      // plaza need a wide normal bias or the soft shadow shows acne rings.
      shadow-normalBias={0.8}
    />
  );
}

/**
 * KHR_materials_transmission glass (a placed house's windows, the drinkware) as plain alpha glass. While one transmissive mesh is on
 * screen three re-renders every opaque object into a transmission target each frame: at the cabin that was ~1,700 extra draw calls
 * for a few window panes. Plain glass loses only the refraction blur.
 */
export function plainGlass(m: THREE.Material | undefined) {
  const p = m as THREE.MeshPhysicalMaterial | undefined;
  if (!p?.isMeshPhysicalMaterial || !(p.transmission > 0)) return;
  p.transmission = 0;
  p.transparent = true;
  p.opacity = Math.min(p.opacity, 0.3);
  p.depthWrite = false;
  p.needsUpdate = true;
}

/**
 * Flags every mesh in the stage as a shadow caster/receiver. The world
 * GLB and the cast figures both arrive as raw primitives (neither sets
 * shadow flags), so the stage tags them itself: opaque meshes cast and
 * receive, transparent ones (the hologlobe shell) only receive. The
 * walk is throttled and skips meshes it has already tagged, so after the
 * first pass it costs a few hundred no-op node visits a few times a
 * second — cast members load async, hence the repeats.
 */
export function ShadowTagger() {
  const scene = useThree((s) => s.scene);
  const acc = useRef(1); // first frame tags immediately
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 0.3) return;
    acc.current = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.__glbShadowTagged) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) plainGlass(m);
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      // the Troyes hall's walls are opaque: with a sun strong enough to cast readable shadows its roof left the hall interior black
      mesh.castShadow = !mat?.transparent && !/^Kit_hall/.test(mesh.name);
      mesh.receiveShadow = true;
      mesh.userData.__glbShadowTagged = true;
    });
  });
  return null;
}
