// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cameraCalibration, decodeDepth, metricDepth, pointVisible, projectRoute, ScoutVision, unpackDepth, type ScoutVisionFrame } from "./scoutVision";

describe("Scout metric vision", () => {
  it("decodes packed perspective depth to metres, reserves sky as zero", () => {
    expect(unpackDepth(255, 255, 255, 255)).toBe(1);
    expect(metricDepth(1, .1, 500)).toBe(0);
    expect(metricDepth(0, .1, 500)).toBeCloseTo(.1);
    for (const z of [.1, 1, 10, 100, 400]) {
      const d = (1 - .1 / z) / (1 - .1 / 500);
      expect(metricDepth(d, .1, 500)).toBeCloseTo(z, 6);
    }
    expect(metricDepth(NaN, .1, 500)).toBe(0);
  });
  it("flips WebGL depth rows to the same top-left order as RGB", () => {
    const pixels = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]);
    expect(decodeDepth(pixels, 1, 2, 1, 10)).toEqual([0, 1]);
  });
  it("publishes calibration that projects known camera-space coordinates", () => {
    const camera = new THREE.PerspectiveCamera(90, 2, .1, 500);
    camera.position.set(1, 2, 3);
    const c = cameraCalibration(camera, 200, 100);
    expect(c.fx).toBeCloseTo(50); expect(c.fy).toBeCloseTo(50);
    expect(c.cx).toBe(100); expect(c.cy).toBe(50);
    expect(c.worldFromCamera.slice(12, 15)).toEqual([1, 2, 3]);
  });
  it("hides points behind walls, behind the camera, outside view, or without a depth sample", () => {
    const camera = new THREE.PerspectiveCamera(90, 1, .1, 100); camera.updateMatrixWorld();
    const depth: ScoutVisionFrame["depth"] = { width: 2, height: 2, units: "m", convention: "camera-z", invalid: 0, values: [5, 5, 5, 5] };
    expect(pointVisible(new THREE.Vector3(0, 0, -4), camera, depth)).toBe(true);
    expect(pointVisible(new THREE.Vector3(0, 0, -6), camera, depth)).toBe(false);
    expect(pointVisible(new THREE.Vector3(0, 0, 4), camera, depth)).toBe(false);
    expect(pointVisible(new THREE.Vector3(8, 0, -4), camera, depth)).toBe(false);
    expect(pointVisible(new THREE.Vector3(0, 0, -4), camera, { ...depth, values: [0, 0, 0, 0] })).toBe(false);
  });
});

 it("projects route coordinates with the observation camera and labels occluded portions", () => {
    const camera = new THREE.PerspectiveCamera(90, 1, .1, 100); camera.updateMatrixWorld();
    const frame = { camera: cameraCalibration(camera, 100, 100), depth: { width: 2, height: 2, units: "m" as const, convention: "camera-z" as const, invalid: 0 as const, values: [5, 5, 5, 5] } };
    const points = projectRoute([[0, 0, -4], [0, 0, -6], [0, 0, 4]], frame);
    expect(points[0].pixel).toEqual([50, 50]);
    expect(points.map(p => p.visibility)).toEqual(["visible", "occluded", "outside"]);
    expect(projectRoute([[0, 0, -4]], { ...frame, depth: { ...frame.depth, values: [0, 0, 0, 0] } })[0].visibility).toBe("unknown");
 });

 it("restores renderer target and hidden body when a capture fails", () => {
    const vision = new ScoutVision(2, 2);
    const target = new THREE.WebGLRenderTarget(2, 2);
    let current = target;
    const renderer = { autoClear: false, getRenderTarget: () => current, setRenderTarget: (t: THREE.WebGLRenderTarget) => { current = t; }, render: () => { throw new Error("GPU failure"); } };
    const body = new THREE.Object3D();
    expect(() => vision.capture(renderer as unknown as THREE.WebGLRenderer, new THREE.Scene(), 0, body)).toThrow("GPU failure");
    expect(current).toBe(target); expect(renderer.autoClear).toBe(false); expect(body.visible).toBe(true);
    vision.dispose(); target.dispose();
 });

describe("ScoutVision.capture hidden objects", () => {
  const fakeRenderer = (renderSpy: (visibleDuring: boolean[]) => void, throwOn = false) => {
    return { getRenderTarget: () => null, autoClear: true, setRenderTarget() {}, readRenderTargetPixels() {},
      render() { renderSpy(hidden.map((o) => o.visible)); if (throwOn) throw new Error("gl lost"); } } as unknown as THREE.WebGLRenderer;
  };
  const hidden = [new THREE.Group(), new THREE.Group()];
  it("hides every listed object during the pass and restores each one afterwards, even when the render throws", () => {
    const rig = Object.create(ScoutVision.prototype) as ScoutVision;
    Object.assign(rig, { camera: new THREE.PerspectiveCamera(), color: {}, packed: {}, copyScene: new THREE.Scene(), copyCamera: new THREE.Camera(), width: 1, height: 1, rgba: new Uint8Array(4), depthBytes: new Uint8Array(4) });
    hidden[0].visible = true; hidden[1].visible = false; // a pre-hidden object must stay hidden afterwards
    let seen: boolean[] = [];
    expect(() => rig.capture(fakeRenderer((v) => { seen = v; }, true), new THREE.Scene(), 0, [hidden[0], null, hidden[1], undefined])).toThrow("gl lost");
    expect(seen).toEqual([false, false]);
    expect([hidden[0].visible, hidden[1].visible]).toEqual([true, false]);
  });
});
