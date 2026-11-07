// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { PILOT_OFF, PILOT_ON, buildInteractableVisual } from "./interactableMesh";
import type { InteractableDef } from "./interactables";

const DEF: InteractableDef = {
  id: "tea-radio",
  room: "tea",
  kind: "radio",
  asset: "vintage_radio_transceiver",
  label: "Radio",
  pos: [-17.9, 1.26, -78.5],
  rotY: 1.5708,
  stand: [-16.9, -78.5],
  heading: -1.5708,
  floorY: 0.48,
};

function library(): { assets: Map<string, THREE.Object3D>; geo: THREE.BufferGeometry; mat: THREE.Material } {
  const geo = new THREE.BoxGeometry(0.3, 0.16, 0.12);
  const mat = new THREE.MeshStandardMaterial();
  const root = new THREE.Group();
  root.name = "LIB_vintage_radio_transceiver";
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.08; // origin at the base, like the Poly Haven assets
  root.add(mesh);
  return { assets: new Map([["vintage_radio_transceiver", root]]), geo, mat };
}

describe("buildInteractableVisual", () => {
  it("places the clone at the def's position and rotation, sharing the library geometry + material", () => {
    const { assets, geo, mat } = library();
    const v = buildInteractableVisual(DEF, assets)!;
    expect(v).not.toBeNull();
    expect(v.group.position.toArray()).toEqual([-17.9, 1.26, -78.5]);
    expect(v.group.rotation.y).toBeCloseTo(1.5708, 4);
    const radio = v.group.children.find((c) => (c as THREE.Mesh).geometry === geo) as THREE.Mesh;
    expect(radio).toBeTruthy();
    expect(radio.material).toBe(mat);
    // The pilot light sits on the top face of the asset (world y = pos.y + 0.16).
    v.group.updateMatrixWorld(true);
    const bead = v.group.getObjectByName("tea-radio:pilot")!;
    expect(bead.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThan(1.26 + 0.16 - 0.01);
  });

  it("the offset shifts the whole prop (debug copies of a room)", () => {
    const { assets } = library();
    const v = buildInteractableVisual(DEF, assets, [10, -4])!;
    expect(v.group.position.x).toBeCloseTo(-7.9);
    expect(v.group.position.z).toBeCloseTo(-82.5);
  });

  it("setOn lights the pilot and shows the halo; off restores the dead bead", () => {
    const { assets } = library();
    const v = buildInteractableVisual(DEF, assets)!;
    const bead = v.group.getObjectByName("tea-radio:pilot") as THREE.Mesh;
    const halo = v.group.getObjectByName("tea-radio:pilot-halo") as THREE.Mesh;
    expect((bead.material as THREE.MeshBasicMaterial).color.getHex()).toBe(PILOT_OFF);
    expect(halo.visible).toBe(false);
    v.setOn(true);
    expect((bead.material as THREE.MeshBasicMaterial).color.getHex()).toBe(PILOT_ON);
    expect(halo.visible).toBe(true);
    v.setOn(false);
    expect((bead.material as THREE.MeshBasicMaterial).color.getHex()).toBe(PILOT_OFF);
    expect(halo.visible).toBe(false);
  });

  it("dispose frees the pilot's own resources only, never the library's, and is idempotent", () => {
    const { assets, geo, mat } = library();
    const libGeoDispose = vi.spyOn(geo, "dispose");
    const libMatDispose = vi.spyOn(mat, "dispose");
    const v = buildInteractableVisual(DEF, assets)!;
    const bead = v.group.getObjectByName("tea-radio:pilot") as THREE.Mesh;
    const beadGeoDispose = vi.spyOn(bead.geometry, "dispose");
    v.dispose();
    v.dispose();
    expect(beadGeoDispose).toHaveBeenCalledTimes(1);
    expect(libGeoDispose).not.toHaveBeenCalled();
    expect(libMatDispose).not.toHaveBeenCalled();
    expect(v.group.getObjectByName("tea-radio:pilot")).toBeUndefined();
  });

  it("returns null when the library lacks the asset", () => {
    expect(buildInteractableVisual(DEF, new Map())).toBeNull();
  });
});
