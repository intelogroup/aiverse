/**
 * Telemetry context — the "where and what build" attached to every
 * captured event: build SHA, current district (derived from the camera,
 * never from user input), camera pose, and a coarse device class.
 *
 * The district list mirrors /assets/districts.json and is refreshed from
 * that very file at init, so this module cannot drift from the world the
 * console actually loads; the built-in copy only covers the first frames
 * before the fetch lands.
 */

export interface DistrictDefLite {
  id: string;
  center: [number, number];
  half: number;
}

export const FALLBACK_DISTRICTS: DistrictDefLite[] = [
  { id: "bazaar", center: [0, 0], half: 180 },
  { id: "glassq", center: [0, -400], half: 180 },
  { id: "foundry", center: [400, 0], half: 180 },
  { id: "terraces", center: [-400, 0], half: 180 },
  { id: "halo", center: [0, 400], half: 180 },
];

let districtDefs: DistrictDefLite[] = FALLBACK_DISTRICTS;

export function setDistrictDefs(defs: DistrictDefLite[]): void {
  if (defs.length) districtDefs = defs;
}

/** Square district bounds (the world's own `half` semantics); the gaps
 *  between districts report as "between" rather than a wrong district. */
export function deriveDistrict(x: number, z: number, defs: DistrictDefLite[] = districtDefs): string {
  for (const d of defs) {
    if (Math.abs(x - d.center[0]) <= d.half && Math.abs(z - d.center[1]) <= d.half) return d.id;
  }
  return "between";
}

export interface CameraPose {
  x: number;
  y: number;
  z: number;
}

let cameraProvider: (() => CameraPose | null) | null = null;

export function registerCameraProvider(fn: () => CameraPose | null): void {
  cameraProvider = fn;
}

export function currentCameraPose(): CameraPose | null {
  try {
    return cameraProvider ? cameraProvider() : null;
  } catch {
    return null;
  }
}

export function currentDistrict(): string {
  const pose = currentCameraPose();
  return pose ? deriveDistrict(pose.x, pose.z) : "unknown";
}

/** Coarse device class for performance comparison — no fingerprinting:
 *  just the buckets that explain FPS differences (phone / tablet /
 *  desktop, and whether the CPU/memory hints are low-end). */
export function deviceClass(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent ?? "";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const base = /Mobi|Android|iPhone|iPod/i.test(ua) ? "phone" : /iPad|Tablet/i.test(ua) ? "tablet" : "desktop";
  const cores = nav.hardwareConcurrency ?? 0;
  const mem = nav.deviceMemory ?? 0;
  const low = (cores > 0 && cores <= 4) || (mem > 0 && mem <= 4);
  return low ? `${base}-low` : base;
}

/** Round a pose for event payloads — replay needs ~0.1 m, not float noise. */
export function roundPose(p: CameraPose): CameraPose {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
}
