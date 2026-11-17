// OwnerFollowCam — drives the Canvas camera as a trail camera behind one streamed body (the signed-in owner's agent). Mounted only
// while following; OrbitControls is parked (enabled=false) for the same period, so nothing fights over the camera. On unmount
// (the user took over, the body left, or another camera feature fired) the orbit pivot is set to where we were looking, so the
// hand-back to OrbitControls does not jump the view back to the opening aerial.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { DAMP_HEADING, DAMP_LOOK, DAMP_POS_FOLLOW, FOV_WIDE, damp, dampAngle } from "./cameraRig";
import { ownFollowPose } from "./ownerFollow";
import type { RemoteBodies } from "./remoteFrames";

/** Fly-in from the opening aerial is faster than the steady trail so the swoop takes about a second and a half. */
const DAMP_POS_ARRIVE = 2.6;
/** Within this distance (m) of the trail pose the camera switches from the arrive rate to the steady rate. */
const ARRIVED_M = 8;

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
}

export function OwnerFollowCam({ bodies, n, onTakeOver }: { bodies: RemoteBodies; n: number; onTakeOver: () => void }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const st = useRef<{ look: THREE.Vector3; heading: number | null } | null>(null);

  useEffect(() => {
    // Start the gaze from the orbit pivot (what the camera is looking at now) so the first frames ease rather than cut.
    const look = controls?.target ? controls.target.clone() : camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(50).add(camera.position);
    st.current = { look, heading: null };
    controls?.addEventListener("start", onTakeOver);
    return () => {
      controls?.removeEventListener("start", onTakeOver);
      const s = st.current;
      st.current = null;
      if (s && controls?.target) {
        controls.target.copy(s.look);
        controls.update();
      }
    };
  }, [camera, controls, onTakeOver]);

  useFrame((_, delta) => {
    const s = st.current;
    const t = bodies.renderTime(performance.now() / 1000);
    if (!s || t === null) return;
    const p = bodies.sample(n, t);
    if (!p) return;
    const dt = Math.min(delta, 0.05);
    s.heading = s.heading === null ? p.heading : dampAngle(s.heading, p.heading, DAMP_HEADING, dt);
    const { cam, look } = ownFollowPose({ x: p.x, y: p.y, z: p.z, heading: s.heading });
    const far = camera.position.distanceTo(new THREE.Vector3(cam[0], cam[1], cam[2])) > ARRIVED_M;
    const rate = far ? DAMP_POS_ARRIVE : DAMP_POS_FOLLOW;
    camera.position.set(damp(camera.position.x, cam[0], rate, dt), damp(camera.position.y, cam[1], rate, dt), damp(camera.position.z, cam[2], rate, dt));
    s.look.set(damp(s.look.x, look[0], DAMP_LOOK, dt), damp(s.look.y, look[1], DAMP_LOOK, dt), damp(s.look.z, look[2], DAMP_LOOK, dt));
    camera.lookAt(s.look);
    controls?.target.copy(s.look);
    if (Math.abs(camera.fov - FOV_WIDE) > 0.01) {
      camera.fov = damp(camera.fov, FOV_WIDE, 8, dt);
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
