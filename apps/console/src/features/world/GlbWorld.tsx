import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
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
// no avatar driving. Cast membership comes from WorldView (owned agents
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

  const camera = useMemo(
    () =>
      agora
        ? { position: [14, 10.5, 14] as [number, number, number], fov: 45, near: 0.1, far: 600 }
        : { position: [-95, 60, 5] as [number, number, number], fov: 45, near: 0.5, far: 3000 },
    [agora],
  );
  const target: [number, number, number] = agora ? [0, 0.8, 0] : [CITY_CENTER[0], 1, CITY_CENTER[1]];

  return (
    <div className="w-glb-root">
      <Canvas key={place} camera={camera} gl={{ antialias: true }} style={{ position: "absolute", inset: 0 }}>
        <ambientLight intensity={0.75} />
        <directionalLight position={agora ? [12, 18, 8] : [-80, 140, 20]} intensity={1.1} />
        <Suspense fallback={null}>
          <WorldEnv url={agora ? AGORA_URL : CITY_URL} />
          <CrowdCast place={place} cast={cast} />
        </Suspense>
        <OrbitControls
          makeDefault
          target={target}
          enableDamping
          maxPolarAngle={Math.PI / 2 - 0.04}
          minDistance={agora ? 4 : 15}
          maxDistance={agora ? 70 : 900}
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
