import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * SPLAT-IN-VERSE TRIAL (branch tmp/splat-in-verse; record:
 * apps/console/splat-trial/TRIAL-NOTES.md).
 *
 * Loads a procedural 3DGS bazaar-stall PLY straight into the verse
 * with Spark (@sparkjsdev/spark 0.1.10 — the last release line that
 * runs on the console's three 0.170; Spark 2.x requires three
 * >= 0.180). Gated behind a query flag; with no flag this component
 * renders nothing and Spark is never even imported, so default
 * behaviour is unchanged.
 *
 *   ?splat=1    -> bazaar-stall-262k.ply (262,144 gaussians)
 *   ?splat=1m   -> bazaar-stall-1m.ply   (1,000,000 gaussians)
 *   ?splat=spz  -> bazaar-stall-262k.spz (same 262k stall, SPZ-packed)
 *
 * The PLY files live in apps/console/splat-trial/ (with their
 * generator); the trial rig stages them into dist/splat-trial/
 * before serving, mirroring how the LOD/batching rigs staged their
 * variant GLBs. Object-level transforms only: the stall is placed
 * once, at SPLAT_POSITION, facing the P1 viewpoint.
 *
 * `?streamDebug=1`-style handle: window.__splatTrial reports
 * { mode, state, loadMs, numSplats, error } for the measure rig.
 */
export const SPLAT_POSITION = new THREE.Vector3(14, 0, 33);

type SplatInfo = {
  mode: string;
  state: "loading" | "ready" | "error";
  t0: number;
  loadMs?: number;
  numSplats?: number | null;
  error?: string;
};

export function SplatTrial() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const mode = useMemo(() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("splat");
    if (v === "1" || v === "262k") return "262k";
    if (v === "1m" || v === "1000000") return "1m";
    if (v === "spz") return "spz";
    return null;
  }, []);

  useEffect(() => {
    if (!mode) return;
    let live = true;
    const w = window as unknown as Record<string, unknown>;
    const info: SplatInfo = { mode, state: "loading", t0: performance.now() };
    w.__splatTrial = info;
    let spark: THREE.Object3D | null = null;
    let mesh: THREE.Object3D | null = null;
    (async () => {
      try {
        const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
        if (!live) return;
        spark = new SparkRenderer({ renderer: gl });
        scene.add(spark);
        const file = mode === "spz" ? "bazaar-stall-262k.spz" : `bazaar-stall-${mode}.ply`;
        const m = new SplatMesh({ url: `/splat-trial/${file}` });
        m.position.copy(SPLAT_POSITION);
        mesh = m;
        scene.add(m);
        await m.initialized;
        if (!live) return;
        info.state = "ready";
        info.loadMs = Math.round(performance.now() - info.t0);
        info.numSplats =
          (m.packedSplats as unknown as { numSplats?: number } | undefined)
            ?.numSplats ?? null;
      } catch (e) {
        if (!live) return;
        info.state = "error";
        info.error = String(e).slice(0, 300);
      }
    })();
    return () => {
      live = false;
      if (mesh) {
        scene.remove(mesh);
        (mesh as unknown as { dispose?: () => void }).dispose?.();
      }
      if (spark) {
        scene.remove(spark);
        (spark as unknown as { dispose?: () => void }).dispose?.();
      }
      delete w.__splatTrial;
    };
  }, [mode, gl, scene]);

  return null;
}
