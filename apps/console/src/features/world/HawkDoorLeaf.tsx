import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import { Raycaster, Vector2, type Group } from "three";
import { HAWK_DOOR, HAWK_DOOR_BOX, HAWK_DOOR_KEY, HawkDoor } from "./hawkDoor";
import { boxesMesh } from "./capsuleWorld";
import type { WalkColliders } from "./walkColliders";
import type { WalkFrameInfo } from "./walkOverride";

export function HawkDoorLeaf({ walk, frame, walking }: {
  walk: WalkColliders;
  frame: RefObject<WalkFrameInfo | null>;
  walking: boolean;
}) {
  const { camera, gl } = useThree();
  const controller = useRef<HawkDoor | null>(null);
  const hinge = useRef<Group>(null);
  const { x, y, z, width, height } = HAWK_DOOR;

  useEffect(() => {
    controller.current = new HawkDoor((blocked) => {
      if (!blocked) {
        walk.drop(HAWK_DOOR_KEY);
        return;
      }
      const mesh = boxesMesh([HAWK_DOOR_BOX], [0, 0], HAWK_DOOR_KEY);
      if (mesh) walk.set(HAWK_DOOR_KEY, [mesh]);
    });
    return () => {
      controller.current = null;
      walk.drop(HAWK_DOOR_KEY);
    };
  }, [walk]);

  useEffect(() => {
    if (!walking) return;
    const canvas = gl.domElement;
    const ray = new Raycaster();
    ray.far = 3;
    const aim = new Vector2();
    const openOnPress = (event: PointerEvent) => {
      if (event.button !== 0 || !hinge.current) return;
      const bounds = canvas.getBoundingClientRect();
      if (document.pointerLockElement === canvas) aim.set(0, 0);
      else aim.set(
        2 * (event.clientX - bounds.left) / bounds.width - 1,
        1 - 2 * (event.clientY - bounds.top) / bounds.height,
      );
      ray.setFromCamera(aim, camera);
      if (ray.intersectObject(hinge.current, true).length) controller.current?.requestOpen();
    };
    canvas.addEventListener("pointerdown", openOnPress);
    return () => canvas.removeEventListener("pointerdown", openOnPress);
  }, [camera, gl, walking]);

  useFrame((_, dt) => {
    const door = controller.current;
    if (!door || !hinge.current) return;
    const walker = walking ? frame.current : null;
    door.tick(dt, walker ? [walker] : []);
    hinge.current.rotation.y = door.openness * Math.PI / 2;
  });

  return (
    <>
      <mesh position={[x + width / 2 + 0.071, y + height / 2, z]} castShadow receiveShadow>
        <boxGeometry args={[0.143, height, 0.12]} />
        <meshStandardMaterial color="#e4d9c5" roughness={0.82} />
      </mesh>
      <group ref={hinge} name="scandi-hawk-front-door" position={[x - width / 2, y, z]}>
        <mesh position={[width / 2, height / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[width - 0.025, height - 0.025, 0.075]} />
          <meshStandardMaterial color="#9d7a56" roughness={0.8} />
        </mesh>
        {[-0.048, 0.048].map((side) => (
          <mesh key={side} position={[width - 0.17, 0.99, side]}>
            <boxGeometry args={[0.13, 0.025, 0.045]} />
            <meshStandardMaterial color="#242421" roughness={0.45} metalness={0.55} />
          </mesh>
        ))}
      </group>
    </>
  );
}
