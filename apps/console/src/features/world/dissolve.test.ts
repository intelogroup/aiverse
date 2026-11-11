import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyDissolve,
  createDissolve,
  createDissolveDepthMaterial,
  DISSOLVE_CACHE_KEY,
  DISSOLVE_DEPTH_CACHE_KEY,
  DISSOLVE_DURATION_S,
} from "./dissolve";

const STEP = 1 / 60;

/** Run update() at 60 fps until pred holds or the cap (seconds) runs out; returns elapsed seconds. */
function runUntil(d: ReturnType<typeof createDissolve>, pred: () => boolean, capS = 5): number {
  let t = 0;
  while (!pred() && t < capS) {
    d.update(STEP);
    t += STEP;
  }
  return t;
}

describe("createDissolve", () => {
  it("starts fully dissolved with the target at present, so a body materializes in", () => {
    const d = createDissolve();
    expect(d.progress).toBe(1);
    expect(d.target).toBe(0);
    expect(d.gone).toBe(false);
    expect(d.uniforms.uProgress.value).toBe(1);
  });

  it("materializes in about the nominal duration and settles exactly at 0", () => {
    const d = createDissolve();
    const t = runUntil(d, () => d.progress === 0);
    expect(t).toBeGreaterThan(DISSOLVE_DURATION_S * 0.7);
    expect(t).toBeLessThan(DISSOLVE_DURATION_S * 1.4);
    expect(d.uniforms.uProgress.value).toBe(0);
  });

  it("leaving reports completion only once, at ~the nominal duration, and stays gone", () => {
    const d = createDissolve();
    runUntil(d, () => d.progress === 0);
    d.leave();
    let completedAt = -1;
    let t = 0;
    while (t < 5) {
      const done = d.update(STEP);
      t += STEP;
      if (done && completedAt < 0) completedAt = t;
      if (completedAt > 0) expect(d.update(STEP)).toBe(true); // stays complete
    }
    expect(completedAt).toBeGreaterThan(DISSOLVE_DURATION_S * 0.7);
    expect(completedAt).toBeLessThan(DISSOLVE_DURATION_S * 1.4);
    expect(d.gone).toBe(true);
    expect(d.uniforms.uProgress.value).toBe(1);
  });

  it("arrive() mid-leave cancels the dissolve and returns to solid", () => {
    const d = createDissolve();
    runUntil(d, () => d.progress === 0);
    d.leave();
    runUntil(d, () => d.progress > 0.5, 2);
    expect(d.progress).toBeGreaterThan(0.5);
    d.arrive();
    expect(d.gone).toBe(false);
    runUntil(d, () => d.progress === 0);
    expect(d.progress).toBe(0);
  });

  it("two instances never share uniforms (per-body isolation)", () => {
    const a = createDissolve();
    const b = createDissolve();
    expect(a.uniforms).not.toBe(b.uniforms);
    expect(a.uniforms.uProgress).not.toBe(b.uniforms.uProgress);
    a.leave();
    runUntil(a, () => a.progress === 1);
    expect(b.progress).toBe(1); // b never moved: still at its spawn state
    b.update(STEP);
    expect(b.progress).toBeLessThan(1); // b materializes on its own clock
    expect(a.progress).toBe(1);
  });
});

// Minimal stand-ins for the shader objects three hands onBeforeCompile: the
// anchor lines are the real chunk includes from the standard/depth shaders.
function fakeShader() {
  return {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n}",
    fragmentShader:
      "#include <common>\nvoid main() {\n#include <clipping_planes_fragment>\nvec3 totalEmissiveRadiance = emissive;\n#include <emissivemap_fragment>\n}",
  };
}

describe("applyDissolve", () => {
  it("injects the discard cut, the field varying and the emissive edge, sharing the state's uniforms", () => {
    const d = createDissolve();
    const mat = new THREE.MeshStandardMaterial();
    applyDissolve(mat, d);
    const shader = fakeShader();
    mat.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms.uProgress).toBe(d.uniforms.uProgress);
    expect(shader.vertexShader).toContain("vDisLocal = position;");
    expect(shader.fragmentShader).toContain("if (disField - disT < 0.0) discard;");
    expect(shader.fragmentShader).toContain("totalEmissiveRadiance += uEdgeColor * disEdge;");
    // The cut is computed before the edge reads it, both inside main().
    expect(shader.fragmentShader.indexOf("disField = disField")).toBeLessThan(
      shader.fragmentShader.indexOf("totalEmissiveRadiance +="),
    );
    expect(mat.customProgramCacheKey()).toBe(DISSOLVE_CACHE_KEY);
  });

  it("never makes the material transparent — the cut is discard, not alpha", () => {
    const d = createDissolve();
    const mat = new THREE.MeshStandardMaterial();
    applyDissolve(mat, d);
    expect(mat.transparent).toBe(false);
    const shader = fakeShader();
    mat.onBeforeCompile(shader as never, null as never);
    expect(shader.fragmentShader).not.toContain("DiffuseColor.a");
  });
});

describe("createDissolveDepthMaterial", () => {
  it("is a depth material carrying the same injection and its own cache key", () => {
    const d = createDissolve();
    const depth = createDissolveDepthMaterial(d);
    expect(depth).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(depth.depthPacking).toBe(THREE.RGBADepthPacking);
    expect(depth.customProgramCacheKey()).toBe(DISSOLVE_DEPTH_CACHE_KEY);
    const shader = fakeShader();
    depth.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms.uProgress).toBe(d.uniforms.uProgress);
    expect(shader.fragmentShader).toContain("discard;");
  });
});
