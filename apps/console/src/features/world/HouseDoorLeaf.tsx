import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Raycaster, Vector2, type Group } from "three";
import { assetUrl } from "../../lib/assetUrl";
import { boxesMesh } from "./capsuleWorld";
import type { City3Room } from "./city3";
import { extendGltf } from "./gltfExtensions";
import { doorBox, doorHinge, doorKey, HouseDoor, slidePanels, type DoorLeafSpec } from "./houseDoor";
import type { WalkColliders } from "./walkColliders";
import type { WalkFrameInfo } from "./walkOverride";

/** Mount a door (controller, blocker, leaf) only while the camera is this close; drop it past DOOR_KEEP. */
const DOOR_MOUNT = 60, DOOR_KEEP = 80;

/** Every room's swinging front door (rooms with `doorLeaf`), mounted near the camera. */
export function HouseDoors({ rooms, walk, frame, walking }: {
  rooms: City3Room[];
  walk: WalkColliders;
  frame: RefObject<WalkFrameInfo | null>;
  walking: boolean;
}) {
  const doors = useMemo(() => rooms.filter((r) => r.doorLeaf), [rooms]);
  const camera = useThree((s) => s.camera);
  const [near, setNear] = useState<string[]>([]);
  useFrame(() => {
    const keep = doors.filter((r) => {
      const d = r.doorLeaf!, dist = Math.hypot(camera.position.x - d.x, camera.position.z - d.z);
      return dist < (near.includes(r.id) ? DOOR_KEEP : DOOR_MOUNT);
    }).map((r) => r.id);
    if (keep.length !== near.length || keep.some((id, i) => id !== near[i])) setNear(keep);
  });
  return (
    <>
      {doors.filter((r) => near.includes(r.id)).map((r) => (
        <HouseDoorLeaf key={r.id} room={r.id} spec={r.doorLeaf!} walk={walk} frame={frame} walking={walking} />
      ))}
    </>
  );
}

function HouseDoorLeaf({ room, spec, walk, frame, walking }: {
  room: string;
  spec: DoorLeafSpec;
  walk: WalkColliders;
  frame: RefObject<WalkFrameInfo | null>;
  walking: boolean;
}) {
  const { camera, gl } = useThree();
  const controller = useRef<HouseDoor | null>(null);
  const swing = useRef<Group>(null);
  const hinge = doorHinge(spec);
  const key = doorKey(room);

  useEffect(() => {
    const box = doorBox(spec);
    controller.current = new HouseDoor(spec, (blocked) => {
      if (!blocked) return walk.drop(key);
      const mesh = boxesMesh([box], [0, 0], key);
      if (mesh) walk.set(key, [mesh]);
    });
    return () => {
      controller.current = null;
      walk.drop(key);
    };
  }, [walk, spec, key]);

  useEffect(() => {
    if (!walking) return;
    const canvas = gl.domElement;
    const ray = new Raycaster();
    ray.far = 3;
    const aim = new Vector2();
    const openOnPress = (event: PointerEvent) => {
      if (event.button !== 0 || !swing.current) return;
      const bounds = canvas.getBoundingClientRect();
      if (document.pointerLockElement === canvas) aim.set(0, 0);
      else aim.set(2 * (event.clientX - bounds.left) / bounds.width - 1, 1 - 2 * (event.clientY - bounds.top) / bounds.height);
      ray.setFromCamera(aim, camera);
      if (ray.intersectObject(swing.current, true).length) controller.current?.requestOpen();
    };
    canvas.addEventListener("pointerdown", openOnPress);
    return () => canvas.removeEventListener("pointerdown", openOnPress);
  }, [camera, gl, walking]);

  const panels = [useRef<Group>(null), useRef<Group>(null)];
  useFrame((_, dt) => {
    const door = controller.current;
    if (!door || !swing.current) return;
    const walker = walking ? frame.current : null;
    door.tick(dt, walker ? [walker] : []);
    if (!spec.slide) swing.current.rotation.y = hinge.sign * door.openness * Math.PI / 2;
    else slidePanels(spec, door.openness).forEach(([x, z], i) => panels[i]!.current?.position.set(x, 0, z));
  });

  const leaf = (width: number) => spec.leaf ? (
    <Suspense fallback={<Slab spec={spec} width={width} />}>
      <LeafModel url={spec.leaf} />
    </Suspense>
  ) : <Slab spec={spec} width={width} />;
  const yaw: [number, number, number] = [0, (spec.yaw * Math.PI) / 180, 0];
  if (spec.slide) {
    // a sliding pair hangs from the left jamb; `swing` is just the raycast target for click-to-open
    const left = doorHinge({ ...spec, hinge: "left" }), lw = spec.leafWidth ?? spec.width / 2;
    return (
      <group position={[left.x, spec.y, left.z]} rotation={yaw}>
        <group ref={swing} name={`${room}-front-door`}>
          {slidePanels(spec, 0).map(([x, z], i) => <group key={i} ref={panels[i]} position={[x, 0, z]}>{leaf(lw)}</group>)}
        </group>
      </group>
    );
  }
  // The leaf is authored from its left jamb (x 0..width); a right-hinged door pivots on the other jamb, so shift it back by the width.
  const offset = spec.hinge === "right" ? -spec.width : 0;
  return (
    <group position={[hinge.x, spec.y, hinge.z]} rotation={yaw}>
      <group ref={swing} name={`${room}-front-door`}>
        <group position={[offset, 0, 0]}>{leaf(spec.width)}</group>
      </group>
    </group>
  );
}

function LeafModel({ url }: { url: string }) {
  const gl = useThree((s) => s.gl);
  const { scene } = useGLTF(assetUrl(url), true, true, extendGltf(gl));
  const leaf = useMemo(() => {
    const s = scene.clone(true);
    s.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    return s;
  }, [scene]);
  return <primitive object={leaf} />;
}

function Slab({ spec, width }: { spec: DoorLeafSpec; width: number }) {
  return (
    <mesh position={[width / 2, spec.height / 2, 0]} castShadow receiveShadow>
      <boxGeometry args={[width - 0.025, spec.height - 0.025, spec.thick ?? 0.075]} />
      <meshStandardMaterial color="#9d7a56" roughness={0.8} />
    </mesh>
  );
}
