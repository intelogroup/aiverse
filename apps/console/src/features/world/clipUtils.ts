// clipUtils.ts — small animation-clip surgery for GLB cast figures.
//
// Deliberately three-only (no DOM, no drei) so it runs headless under
// vitest, same as locomotion.ts.

import * as THREE from "three";

/**
 * Remove net root travel from a looping clip, in place on a CLONE.
 *
 * Mixamo's traveling walks animate the hips bone along the ground: played
 * raw under a crowd-driven group, the figure would stride away from its
 * crowd position and snap back every loop. For each component of the
 * hips translation track we subtract the linear ramp from the first key
 * to the last, so the loop ends where it started (first == last after
 * the fix, so looping stays seamless) while the in-cycle oscillation —
 * the bounce and sway that make the gait read — is preserved.
 *
 * Returns the same clip for chaining. Clips without a matching track
 * (or with a degenerate single-key track) are returned untouched.
 */
export function pinRootMotion(clip: THREE.AnimationClip, boneNamePart = "Hips"): THREE.AnimationClip {
  const track = clip.tracks.find(
    (t) => t.name.endsWith(".position") && t.name.includes(boneNamePart),
  ) as THREE.VectorKeyframeTrack | undefined;
  if (!track || track.times.length < 2) return clip;

  const { times, values } = track;
  const n = times.length;
  const t0 = times[0];
  const span = times[n - 1] - t0;
  if (span <= 0) return clip;

  for (let c = 0; c < 3; c++) {
    const first = values[c];
    const last = values[(n - 1) * 3 + c];
    if (first === last) continue; // already in place on this axis
    for (let i = 0; i < n; i++) {
      const f = (times[i] - t0) / span;
      values[i * 3 + c] -= (last - first) * f;
    }
  }
  return clip;
}
