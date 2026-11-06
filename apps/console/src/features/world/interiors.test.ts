import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildInterior, indexLibrary } from "./interiorBuild";
import { bakeCollisionRoot, boxesMesh, createCapsuleWorld } from "./capsuleWorld";
import { WalkColliders } from "./walkColliders";
import { colUrl, groupByAsset, parseColBoxes, planStreaming, type InteriorLayout, type StreamHero } from "./interiors";

const heroes: StreamHero[] = [
  { id: "a", center: [0, 0] },
  { id: "b", center: [100, 0] },
  { id: "c", center: [200, 0] },
  { id: "d", center: [60, 0] },
];
const cam = (x: number) => ({ x, y: 10, z: 0 });
const base = { heroes, loadWithin: 70, keepWithin: 120, maxLoaded: 2 };

describe("planStreaming", () => {
  it("loads nearest-first and respects the cap", () => {
    const p = planStreaming({ ...base, cam: cam(50), loaded: [] });
    // camera at x=50: d is 10 m away; a and b are both ~51 m away, so the tie breaks on id
    expect(p.load).toEqual(["d", "a"]);
    expect(p.evict).toEqual([]);
  });
  it("evicts rooms beyond the keep radius, and only those", () => {
    const p = planStreaming({ ...base, cam: cam(150), loaded: ["a", "b"] });
    expect(p.evict).toContain("a"); // 150 m away > keep 120
    expect(p.evict).not.toContain("b"); // 50 m away
  });
  it("hysteresis: a loaded room survives between the load and keep radii, a fresh one is not loaded", () => {
    const stay = planStreaming({ ...base, cam: cam(-100), loaded: ["a"] }); // 100 m: > load 70, < keep 120
    expect(stay.evict).toEqual([]);
    const fresh = planStreaming({ ...base, cam: cam(-100), loaded: [] });
    expect(fresh.load).toEqual([]);
  });
  it("never exceeds maxLoaded and drops the farthest when over capacity", () => {
    const p = planStreaming({ ...base, cam: cam(55), loaded: ["a", "b", "d"], maxLoaded: 2 });
    const resident = new Set(["a", "b", "d"]);
    p.evict.forEach((id) => resident.delete(id));
    p.load.forEach((id) => resident.add(id));
    expect(resident.size).toBeLessThanOrEqual(2);
    expect(resident.has("d")).toBe(true); // 5 m away stays
    expect(p.evict).toEqual(["a"]); // a (56 m) is farther than b (46 m): the farthest goes
  });
  it("is stable: applying a plan then replanning from the same camera changes nothing", () => {
    for (let x = -50; x <= 260; x += 7) {
      let loaded: string[] = [];
      for (let k = 0; k < 3; k++) {
        const p = planStreaming({ ...base, cam: cam(x), loaded });
        loaded = loaded.filter((i) => !p.evict.includes(i)).concat(p.load);
      }
      const again = planStreaming({ ...base, cam: cam(x), loaded });
      expect(again).toEqual({ load: [], evict: [] });
      expect(loaded.length).toBeLessThanOrEqual(base.maxLoaded);
    }
  });
});

function library(): THREE.Object3D {
  const lib = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  box.name = "LIB_box";
  lib.add(box);
  const pair = new THREE.Group();
  pair.name = "LIB_pair";
  const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  m2.position.set(0, 2, 0); // a primitive offset inside its asset
  pair.add(m1, m2);
  lib.add(pair);
  return lib;
}

describe("buildInterior", () => {
  const layout: InteriorLayout = {
    id: "t",
    library: "x",
    props: [
      ["box", 1, 0, 2, 0, 1],
      ["box", 3, 0, 4, Math.PI / 2, 2],
      ["pair", 10, 0, 10, 0, 1],
      ["missing", 0, 0, 0, 0, 1],
    ],
  };
  it("makes one instanced draw per asset primitive and skips unknown assets", () => {
    const h = buildInterior(layout, indexLibrary(library()));
    expect(h.drawCalls).toBe(3); // box + two primitives of pair
    expect(h.instances).toBe(4); // 2 boxes + 1 pair x 2 primitives
    expect(h.group.children.every((c) => (c as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
  });
  it("places instances where the layout says, including a primitive's offset inside its asset", () => {
    const h = buildInterior(layout, indexLibrary(library()));
    const box = h.group.children.find((c) => c.name.startsWith("box")) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    box.getMatrixAt(1, m);
    m.decompose(p, q, s);
    expect([p.x, p.y, p.z]).toEqual([3, 0, 4]);
    expect(s.x).toBeCloseTo(2);
    expect(new THREE.Euler().setFromQuaternion(q).y).toBeCloseTo(Math.PI / 2);
    const upper = h.group.children.filter((c) => c.name.startsWith("pair"))[1] as THREE.InstancedMesh;
    upper.getMatrixAt(0, m);
    m.decompose(p, q, s);
    expect(p.toArray()).toEqual([10, 2, 10]);
  });
  it("offset shifts every instance in XZ only", () => {
    const h = buildInterior(layout, indexLibrary(library()), [100, -50]);
    const box = h.group.children[0] as THREE.InstancedMesh;
    const p = new THREE.Vector3();
    const m = new THREE.Matrix4();
    box.getMatrixAt(0, m);
    m.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
    expect([p.x, p.y, p.z]).toEqual([101, 0, -48]);
  });
  it("dispose frees instance buffers, never the shared geometry or material, and is idempotent", () => {
    const lib = library();
    const shared = lib.children[0] as THREE.Mesh;
    let geoDisposed = 0;
    let matDisposed = 0;
    shared.geometry.addEventListener("dispose", () => geoDisposed++);
    (shared.material as THREE.Material).addEventListener("dispose", () => matDisposed++);
    const h = buildInterior(layout, indexLibrary(lib));
    const ims = [...h.group.children] as THREE.InstancedMesh[];
    let freed = 0;
    ims.forEach((im) => im.addEventListener("dispose", () => freed++));
    h.dispose();
    h.dispose();
    expect(freed).toBe(ims.length);
    expect(h.group.children.length).toBe(0);
    expect(geoDisposed).toBe(0);
    expect(matDisposed).toBe(0);
  });
});

describe("groupByAsset", () => {
  it("keeps placement order per asset", () => {
    const g = groupByAsset([
      ["a", 1, 0, 0, 0, 1],
      ["b", 2, 0, 0, 0, 1],
      ["a", 3, 0, 0, 0, 1],
    ]);
    expect(g.get("a")!.map((p) => p[1])).toEqual([1, 3]);
    expect(g.get("b")!.length).toBe(1);
  });
});

describe("interior collision sidecar", () => {
  it("colUrl maps a layout url to its .col.json", () => {
    expect(colUrl("/assets/interiors/shop-100.json")).toBe("/assets/interiors/shop-100.col.json");
    expect(colUrl("/assets/interiors/press.json")).toBe("/assets/interiors/press.col.json");
  });
  it("parseColBoxes takes arrays or {boxes}, drops malformed and degenerate boxes", () => {
    const good = [1, 2, 0.5, 0.6, 0.28, 1.2, 0.3];
    expect(parseColBoxes([good, [1, 2, 3], "x", [1, 2, 0, 0.6, 0, 1, 0], [1, 2, 1, 1, 1, 1, 0], [1, 2, 1, 1, 0, 1]])).toEqual([good, [1, 2, 1, 1, 0, 1, 0]]);
    expect(parseColBoxes({ boxes: [good] })).toEqual([good]);
    expect(parseColBoxes(null)).toEqual([]);
    expect(parseColBoxes({ nope: 1 })).toEqual([]);
  });
});

describe("interior boxes register with the walker list", () => {
  it("a streamed room's boxes block, shift with the room, and are freed on drop", () => {
    const reg = new WalkColliders();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2));
    floor.position.y = 0.28;
    floor.updateMatrixWorld(true);
    reg.set("resident", [bakeCollisionRoot(floor)!]);
    const world = createCapsuleWorld(reg.list);
    const boxes = parseColBoxes([[0, 0, 1, 0.5, 0.28, 1.1, 0]]);
    reg.set("interior:a", [boxesMesh(boxes, [30, 40])!]);
    expect(world.blocked([28.2, 0.28, 40], [29, 0.28, 40], 0.4)).not.toBeNull(); // shifted by the room offset
    expect(world.blocked([-2, 0.28, 0], [-1, 0.28, 0], 0.4)).toBeNull(); // not at the unshifted place
    expect(reg.stats().sets).toEqual(["resident", "interior:a"]);
    reg.drop("interior:a");
    expect(world.blocked([28.2, 0.28, 40], [29, 0.28, 40], 0.4)).toBeNull();
    expect(reg.stats().drops).toBe(1);
    expect(reg.stats().meshes).toBe(1);
    reg.dropAll();
    expect(reg.list().length).toBe(0);
  });
});
