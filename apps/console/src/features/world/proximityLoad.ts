import { useFrame, useThree } from "@react-three/fiber";
import { useRef, useState } from "react";

// proximityLoad — resident figures (the Bazaar keeper and patrol, the Tea House bartender) each pull a 4-9 MB character GLB.
// Measured 2026-11-22 (cold cache, iPhone emulation, plain `/`): cast-mage 4.45 MB + cast-remy 9.20 MB = 13.65 MB at ~3 s, i.e.
// 42% of a 32.55 MB first visit, for figures that are ~7 px tall from the default 450 m aerial camera. So a resident's model is
// requested only once the camera has come within LOAD_RADIUS of it, and stays loaded after that (one-way latch: no unmount
// thrash, and useGLTF keeps the parsed asset anyway). The resident's simulation keeps running either way; only the model waits.

/** Metres (3D, camera to the figure). At 160 m a 1.7 m figure is ~8 px tall on an 800 px canvas (fov 50): the first size worth drawing. */
export const RESIDENT_LOAD_RADIUS = 160;

export function withinLoadRadius(cx: number, cy: number, cz: number, tx: number, ty: number, tz: number, r = RESIDENT_LOAD_RADIUS): boolean {
  const dx = cx - tx, dy = cy - ty, dz = cz - tz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** True (and stays true) once the camera has been within `radius` of `target`. Costs one distance check per frame until it trips. */
export function useProximityLatch(target: readonly [number, number, number], radius = RESIDENT_LOAD_RADIUS): boolean {
  const camera = useThree((s) => s.camera);
  const tripped = useRef(false);
  const [on, setOn] = useState(false);
  useFrame(() => {
    if (tripped.current) return;
    const p = camera.position;
    if (withinLoadRadius(p.x, p.y, p.z, target[0], target[1], target[2], radius)) {
      tripped.current = true;
      setOn(true);
    }
  });
  return on;
}
