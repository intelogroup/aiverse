import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  buildRectGeometry,
  createGeometryCrowd,
  createPlatformCrowd,
  type AgentFrame,
  type PlatformCrowd,
} from "./locomotion";
import { CastFigure } from "./CastFigure";

// GlbWorld — the modeled worlds (Blender-authored GLBs) as the console's
// default stage. Two places share one cast:
//
//   Agora — the lobby island. The crowd walks the deck disc (r = 9.7 m)
//   with the hologlobe as a central keep-out (r = 2.2 m): the annulus
//   navmesh locomotion.ts builds for exactly this, spike-proven.
//   City — World One's street grid. @recast-navigation/three is not among
//   the console's dependencies, so instead of meshing the whole city the
//   crowd walks a bounded street rectangle in world coordinates over the
//   dense district (geometry-verified from the GLB: roads surface
//   y = 0.2 m, densest fabric around x −210..−120, z −90 in three.js
//   space — the Blender Y axis lands negated in glTF Z).
//
// Spectator framing throughout: a perspective camera + OrbitControls,
// no avatar driving. Each place opens at an elevated three-quarter view
// that frames its whole play area; OrbitControls stays above the horizon
// so nobody can duck under the world. The stage is lit for PBR: the
// Agora wears its authored sky (a Blender-baked equirect panorama as
// background + PMREM image-based light, with matched exponential fog);
// the City still uses three's built-in RoomEnvironment. One
// shadow-casting key light per place for grounding, and a modest
// ambient fill. Cast membership comes from WorldView (owned agents
// first, then the public roster) — the same data the ring world's
// figures are drawn from.

export type CastMember = { id: string; name: string };
type Place = "agora" | "city";

const AGORA_URL = "/assets/world-agora.glb";
const CITY_URL = "/assets/world-city.glb";

const AGORA_DECK_RADIUS = 9.7;
const AGORA_KEEP_OUT = 2.2;
const AGORA_GROUND_Y = 0.84; // deck top surface

const CITY_CENTER: [number, number] = [-165, -95]; // XZ, three.js space
const CITY_RECT_W = 110;
const CITY_RECT_D = 70;
const CITY_GROUND_Y = 0.2; // roads surface

/** Deterministic stand-here spots (pre-first-frame + crowd spawn points). */
function homeFor(place: Place, i: number, n: number): [number, number, number] {
  if (place === "agora") {
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    const r = 6; // inside the annulus walkable band (2.2 keep-out, 9.7 rim)
    return [Math.cos(a) * r, AGORA_GROUND_Y, Math.sin(a) * r];
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = CITY_CENTER[0] - CITY_RECT_W / 2 + 10 + col * ((CITY_RECT_W - 20) / Math.max(1, cols - 1 || 1));
  const z = CITY_CENTER[1] - CITY_RECT_D / 2 + 10 + row * 20;
  return [x, CITY_GROUND_Y, z];
}

function WorldEnv({ url }: { url: string }) {
  const gltf = useGLTF(url);
  return <primitive object={gltf.scene} />;
}

const SKY_URL = "/assets/sky-equi.jpg";
// Atmosphere values graded against the primary design boards (Blender
// sky pass, 2026-11-04): the mist in the Blender scene blends toward
// #46548c over 25–210 m; FogExp2 at this density reaches the same ~10%
// haze at 100 m, so depth reads identically in renders and live.
const SKY_FOG_COLOR = 0x46548c;
const SKY_FOG_DENSITY = 0.0035;

/**
 * Environment per place (the Canvas remounts per place).
 *
 * Agora wears the authored sky: an equirectangular panorama baked from
 * the Blender scene (gradient + nebula + spire ring) serves as both the
 * visible background and the PMREM image-based light, and a matched
 * FogExp2 supplies the distance haze the Blender mist pass grades with.
 * Environment intensity stays near the old RoomEnvironment level so the
 * worlds' emissive glow rings and eye screens still read as glow, and a
 * slight exposure lift keeps the dark deck plates from washing to black.
 *
 * City keeps the neutral RoomEnvironment for now — it gets its own sky
 * pass later; the Agora fog density would drown its 450 m sightlines.
 */
function StageEnvironment({ place }: { place: Place }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    // Matched tone-curve pair with the Blender authoring (AgX view transform):
    // R3F otherwise defaults to ACES Filmic, which grades the stage on a
    // different curve than the one it was authored under.
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = 1.1;
    if (place === "city") {
      const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;
      scene.environmentIntensity = 0.6;
      return () => {
        scene.environment = null;
        envMap.dispose();
        pmrem.dispose();
      };
    }
    let live = true;
    const tex = new THREE.TextureLoader().load(SKY_URL, (t) => {
      if (!live) return;
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.colorSpace = THREE.SRGBColorSpace;
      const envMap = pmrem.fromEquirectangular(t).texture;
      scene.background = t;
      scene.environment = envMap;
      scene.environmentIntensity = 0.55;
      scene.fog = new THREE.FogExp2(SKY_FOG_COLOR, SKY_FOG_DENSITY);
      tex.userData.envMap = envMap;
    });
    return () => {
      live = false;
      const envMap = tex.userData.envMap as THREE.Texture | undefined;
      scene.background = null;
      scene.environment = null;
      scene.fog = null;
      envMap?.dispose();
      tex.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, place]);
  return null;
}

/**
 * One shadow-casting key light per place, its ortho shadow camera fitted
 * to the play area. The target is added to the scene graph explicitly —
 * three only tracks a light's aim if the target's matrixWorld updates.
 */
function KeyLight({ place }: { place: Place }) {
  const light = useRef<THREE.DirectionalLight>(null!);
  const scene = useThree((s) => s.scene);
  const agora = place === "agora";
  useEffect(() => {
    const l = light.current;
    l.target.position.set(agora ? 0 : CITY_CENTER[0], 0, agora ? 0 : CITY_CENTER[1]);
    scene.add(l.target);
    l.target.updateMatrixWorld();
    return () => {
      l.target.removeFromParent();
    };
  }, [agora, scene]);
  return (
    <directionalLight
      ref={light}
      castShadow
      position={agora ? [14, 22, 10] : [-75, 150, -30]}
      intensity={agora ? 1.5 : 2.6}
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-camera-left={agora ? -13 : -72}
      shadow-camera-right={agora ? 13 : 72}
      shadow-camera-top={agora ? 13 : 72}
      shadow-camera-bottom={agora ? -13 : -72}
      shadow-camera-near={agora ? 2 : 10}
      shadow-camera-far={agora ? 60 : 340}
      shadow-bias={-0.00015}
      shadow-normalBias={agora ? 0.02 : 0.06}
    />
  );
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
function ShadowTagger() {
  const scene = useThree((s) => s.scene);
  const acc = useRef(1); // first frame tags immediately
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 0.3) return;
    acc.current = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.__glbShadowTagged) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      mesh.castShadow = !mat?.transparent;
      mesh.receiveShadow = true;
      mesh.userData.__glbShadowTagged = true;
    });
  });
  return null;
}

/** Owns one Recast crowd for the active place and steps it every frame. */
function CrowdCast({ place, cast }: { place: Place; cast: CastMember[] }) {
  const crowdRef = useRef<PlatformCrowd | null>(null);
  const framesRef = useRef<AgentFrame[]>([]);
  const [crowdReady, setCrowdReady] = useState(false);
  const count = cast.length;

  useEffect(() => {
    let live = true;
    setCrowdReady(false);
    const initialPositions: [number, number][] = Array.from({ length: count }, (_, i) => {
      const h = homeFor(place, i, count);
      return [h[0], h[2]];
    });
    const building =
      place === "agora"
        ? createPlatformCrowd(AGORA_DECK_RADIUS, count, {
            keepOutRadius: AGORA_KEEP_OUT,
            initialPositions,
          })
        : (() => {
            const geo = buildRectGeometry(
              CITY_CENTER[0],
              CITY_CENTER[1],
              CITY_GROUND_Y,
              CITY_RECT_W,
              CITY_RECT_D,
            );
            return createGeometryCrowd(geo.positions, geo.indices, count, {
              cellSize: 0.5,
              initialPositions,
            });
          })();
    building
      .then((c) => {
        if (!live) {
          c.dispose();
          return;
        }
        crowdRef.current = c;
        setCrowdReady(true);
      })
      .catch(() => {});
    return () => {
      live = false;
      crowdRef.current?.dispose();
      crowdRef.current = null;
    };
    // Rebuilt per place; membership changes reconcile via setAgentCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  useEffect(() => {
    if (crowdReady) crowdRef.current?.setAgentCount(count);
  }, [count, crowdReady]);

  useFrame((_, delta) => {
    const crowd = crowdRef.current;
    if (!crowd) return;
    framesRef.current = crowd.step(Math.min(delta, 0.05));
  });

  const groundY = place === "agora" ? AGORA_GROUND_Y : CITY_GROUND_Y;

  return (
    <>
      {cast.map((member, i) => (
        <CastFigure
          key={member.id}
          framesRef={framesRef}
          index={i}
          baseY={groundY}
          home={homeFor(place, i, count)}
          label={member.name}
        />
      ))}
    </>
  );
}

export function GlbWorld({ cast }: { cast: CastMember[] }) {
  const [place, setPlace] = useState<Place>("agora");
  const agora = place === "agora";

  // Elevated three-quarter spectator defaults, worked out from the play
  // areas: Agora from 25 m at ~37° elevation frames the whole 9.7 m deck
  // disc with headroom; City from ~114 m at ~40° frames the whole
  // 110×70 m street rectangle the same way.
  const camera = useMemo(
    () =>
      agora
        ? { position: [14, 16, 14] as [number, number, number], fov: 45, near: 0.1, far: 600 }
        : { position: [-103, 74, -33] as [number, number, number], fov: 45, near: 0.5, far: 3000 },
    [agora],
  );
  const target: [number, number, number] = agora
    ? [0, AGORA_GROUND_Y, 0]
    : [CITY_CENTER[0], 1, CITY_CENTER[1]];

  return (
    <div className="w-glb-root">
      <Canvas
        key={place}
        camera={camera}
        shadows="soft"
        gl={{ antialias: true }}
        style={{ position: "absolute", inset: 0 }}
      >
        <ambientLight intensity={0.12} color="#8fa3cc" />
        <StageEnvironment place={place} />
        <KeyLight place={place} />
        <ShadowTagger />
        {agora ? (
          <EffectComposer>
            <Bloom
              mipmapBlur
              intensity={0.4}
              luminanceThreshold={0.6}
              luminanceSmoothing={0.2}
            />
          </EffectComposer>
        ) : null}
        <Suspense fallback={null}>
          <WorldEnv url={agora ? AGORA_URL : CITY_URL} />
          <CrowdCast place={place} cast={cast} />
        </Suspense>
        <OrbitControls
          makeDefault
          target={target}
          enableDamping
          maxPolarAngle={Math.PI / 2 - 0.04}
          minDistance={agora ? 6 : 20}
          maxDistance={agora ? 55 : 450}
        />
      </Canvas>
      <div className="w-glb-toggle" role="group" aria-label="Choose world">
        <button type="button" className={agora ? "active" : ""} onClick={() => setPlace("agora")}>
          Agora
        </button>
        <button type="button" className={!agora ? "active" : ""} onClick={() => setPlace("city")}>
          City
        </button>
      </div>
    </div>
  );
}
