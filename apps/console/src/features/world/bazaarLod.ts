import * as THREE from "three";

/**
 * Bazaar prop LOD trial (tmp/lod-bazaar, ?lod=1 only — nothing here runs in
 * the default console path).
 *
 * The variant scene asset (apps/console/lod-trial/world-city3-lod.glb) carries
 * meshoptimizer-simplified copies of the bazaar's repeated props (stalls,
 * instanced goods, fountain pots) as extra child nodes named `__lvl1/2/3`
 * under each original prop node, each with `extras.lod = { level, error,
 * tris, srcTris }` (GLTFLoader surfaces extras as userData). LOD0 is the
 * untouched original geometry — the near view is lossless. No quantization
 * anywhere: levels are float32 simplifications of the decoded source.
 *
 * Switching is by SCREEN-SPACE ERROR (the LOD Editor approach): a level
 * engages only when its geometric error, projected through the actual
 * camera, is below the error target of 1 px:
 *
 *     switchDistance_k = error_k * worldScale * projFactor / ERROR_TARGET_PX
 *     projFactor       = drawingBufferHeightPx / (2 * tan(fov / 2))
 *
 * Selection replicates three r170's THREE.LOD.update, except the measured
 * distance is the EFFECTIVE distance to the prop: the camera's distance to
 * the NEAREST instance (per-instance centres, not the set's bounding
 * sphere — a bazaar-wide instance set's sphere is mostly empty space and
 * its surface sits metres from every actual instance, which would pin the
 * set at LOD0 from anywhere inside the bazaar) minus that instance's
 * radius. A far level never engages while any instance of the set is
 * close. (The price of set-level LOD: one near instance keeps the whole
 * set at the near level. Per-cluster LOD would fix that but adds draw
 * calls — the wrong direction for this trial.)
 *
 * A final empty level culls the prop entirely once even its full extent
 * projects below 1 px (same rule, error := instance diameter).
 */

const ERROR_TARGET_PX = 1;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

class ScreenSpaceLod extends THREE.LOD {
  /** Per-instance centres, LOD-local (one entry for a non-instanced prop). */
  centersLocal: THREE.Vector3[] = [new THREE.Vector3()];
  /** Largest single-instance bounding radius, LOD-local. */
  instanceRadiusLocal = 0;
  /** Active level index (mirrors the base class's private _currentLevel). */
  currentLevelIdx = 0;

  override update(camera: THREE.Camera) {
    const levels = this.levels;
    if (levels.length > 1) {
      // Effective distance: to the nearest instance's bounding sphere.
      _v1.setFromMatrixPosition(camera.matrixWorld);
      this.getWorldScale(_v3);
      const radiusWorld = this.instanceRadiusLocal * Math.max(_v3.x, _v3.y, _v3.z);
      let nearest = Infinity;
      for (const c of this.centersLocal) {
        _v2.copy(c).applyMatrix4(this.matrixWorld);
        const d = _v1.distanceTo(_v2) - radiusWorld;
        if (d < nearest) nearest = d;
      }
      const distance =
        Math.max(0, nearest) / ((camera as THREE.PerspectiveCamera).zoom || 1);

      // Selection loop: three r170 LOD.update, verbatim apart from `distance`.
      levels[0].object.visible = true;
      let i: number, l: number;
      for (i = 1, l = levels.length; i < l; i++) {
        let levelDistance = levels[i].distance;
        if (levels[i].object.visible) {
          levelDistance -= levelDistance * levels[i].hysteresis;
        }
        if (distance >= levelDistance) {
          levels[i - 1].object.visible = false;
          levels[i].object.visible = true;
        } else {
          break;
        }
      }
      this.currentLevelIdx = i - 1;
      for (; i < l; i++) {
        levels[i].object.visible = false;
      }
    }
  }
}

interface LodExtras {
  level: number;
  error: number;
  tris: number;
  srcTris: number;
}

const LVL_NAME = /^__lvl(\d+)(?:_\d+)?$/;

/** Prim meshes of a loaded glTF node object (itself, or its non-LOD children). */
function primObjectsOf(node: THREE.Object3D): THREE.Object3D[] {
  if ((node as THREE.Mesh).isMesh || (node as THREE.InstancedMesh).isInstancedMesh) return [node];
  return node.children.filter(
    (c) =>
      ((c as THREE.Mesh).isMesh || (c as THREE.InstancedMesh).isInstancedMesh) && !LVL_NAME.test(c.name),
  );
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Bounds of a prop in its own local space: every instance's centre (the
 * geometry bounding-sphere centre through the full instance matrix), the
 * largest single-instance radius and diameter (the cull threshold basis),
 * and the largest instance scale (the simplification error lives in
 * geometry space, so it scales with it).
 */
function propBounds(node: THREE.Object3D): { centers: THREE.Vector3[]; instanceRadius: number; instanceDiameter: number; maxInstanceScale: number } {
  const centers: THREE.Vector3[] = [];
  let instanceRadius = 0;
  let instanceDiameter = 0;
  let maxInstanceScale = 1;
  for (const prim of primObjectsOf(node)) {
    const mesh = prim as THREE.Mesh;
    const geo = mesh.geometry as THREE.BufferGeometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const gs = geo.boundingSphere!;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const im = mesh as THREE.InstancedMesh;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m);
        _m.decompose(_p, _q, _s);
        const sc = Math.max(_s.x, _s.y, _s.z);
        if (sc > maxInstanceScale) maxInstanceScale = sc;
        const r = gs.radius * sc;
        instanceRadius = Math.max(instanceRadius, r);
        instanceDiameter = Math.max(instanceDiameter, 2 * r);
        centers.push(gs.center.clone().applyMatrix4(_m));
      }
    } else {
      instanceRadius = Math.max(instanceRadius, gs.radius);
      instanceDiameter = Math.max(instanceDiameter, 2 * gs.radius);
      centers.push(gs.center.clone());
    }
  }
  if (centers.length === 0) centers.push(new THREE.Vector3());
  return { centers, instanceRadius, instanceDiameter, maxInstanceScale };
}

export interface BazaarLodHandle {
  count: number;
  /** Current level histogram across all trial LODs (index = level, last = culled). */
  histogram: () => Record<string, number>;
  /**
   * Exact prop-set triangle census at the current level selection:
   * trisNow sums the ACTIVE level of every LOD (geometry tris x instance
   * count), trisLod0 the level-0 total. Frustum-independent — it measures
   * level selection itself, not what one frame happened to draw.
   */
  census: () => { trisNow: number; trisLod0: number };
}

declare global {
  interface Window {
    __bazaarLod?: BazaarLodHandle;
  }
}

/**
 * Wrap every prop node carrying `__lvl*` children in a ScreenSpaceLod.
 * Runs AFTER colliders are built from the pristine scene: LOD0 level objects
 * are the very same mesh objects (re-parented), so camera collision keeps
 * working on the original geometry. Idempotent — safe on remount.
 */
export function applyBazaarLod(
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): BazaarLodHandle {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const projFactor = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  root.updateWorldMatrix(true, true);

  const targets: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.LOD).isLOD) return;
    if (o.children.some((c) => LVL_NAME.test(c.name) && (c.userData as { lod?: LodExtras }).lod)) targets.push(o);
  });

  const lods: ScreenSpaceLod[] = [];
  for (const node of targets) {
    const parent = node.parent;
    if (!parent) continue;
    const lvlChildren = node.children
      .filter((c) => LVL_NAME.test(c.name) && (c.userData as { lod?: LodExtras }).lod)
      .sort(
        (a, b) =>
          ((a.userData as { lod: LodExtras }).lod.level - (b.userData as { lod: LodExtras }).lod.level),
      );
    if (lvlChildren.length === 0) continue;

    const bounds = propBounds(node);
    node.getWorldScale(_v3);
    const worldScale = Math.max(_v3.x, _v3.y, _v3.z);
    const errScale = worldScale * bounds.maxInstanceScale;

    const lod = new ScreenSpaceLod();
    lod.name = node.name;
    lod.position.copy(node.position);
    lod.quaternion.copy(node.quaternion);
    lod.scale.copy(node.scale);
    lod.centersLocal = bounds.centers;
    lod.instanceRadiusLocal = bounds.instanceRadius;
    lod.userData.lodTrial = { srcName: node.name, projFactor };

    // Detach the level children from the LOD0 node, then move the node
    // itself into the LOD as level 0 with an identity local transform.
    for (const child of lvlChildren) node.remove(child);
    const childIndex = parent.children.indexOf(node);
    parent.remove(node);
    node.position.set(0, 0, 0);
    node.quaternion.identity();
    node.scale.set(1, 1, 1);
    lod.addLevel(node, 0);

    let lastDistance = 0;
    const levelInfo: Array<{ level: number; error: number; distance: number }> = [];
    for (const child of lvlChildren) {
      const extras = (child.userData as { lod: LodExtras }).lod;
      const distance = (extras.error * errScale * projFactor) / ERROR_TARGET_PX;
      child.position.set(0, 0, 0);
      child.quaternion.identity();
      child.scale.set(1, 1, 1);
      lod.addLevel(child, distance);
      lastDistance = Math.max(lastDistance, distance);
      levelInfo.push({ level: extras.level, error: extras.error, distance });
    }
    // Cull level: the whole prop is sub-pixel once the nearest instance's
    // full extent projects under the error target.
    const cullDistance = Math.max(
      (bounds.instanceDiameter * worldScale * projFactor) / ERROR_TARGET_PX,
      lastDistance + 1,
    );
    lod.addLevel(new THREE.Object3D(), cullDistance);
    levelInfo.push({ level: lvlChildren.length + 1, error: bounds.instanceDiameter * worldScale, distance: cullDistance });
    lod.userData.lodTrial.levels = levelInfo;

    parent.add(lod);
    // Restore the node's original slot among its siblings.
    const siblings = parent.children;
    siblings.splice(siblings.indexOf(lod), 1);
    siblings.splice(childIndex, 0, lod);
    lods.push(lod);
  }

  const trisOfObject = (o: THREE.Object3D): number => {
    let t = 0;
    const add = (m: THREE.Object3D) => {
      const mesh = m as THREE.Mesh;
      const g = mesh.geometry as THREE.BufferGeometry | undefined;
      if (g) t += ((g.index ? g.index.count : g.attributes.position.count) / 3) * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
    };
    if ((o as THREE.Mesh).isMesh || (o as THREE.InstancedMesh).isInstancedMesh) add(o);
    for (const c of o.children) if ((c as THREE.Mesh).isMesh || (c as THREE.InstancedMesh).isInstancedMesh) add(c);
    return t;
  };
  const handle: BazaarLodHandle = {
    count: lods.length,
    histogram: () => {
      const h: Record<string, number> = {};
      for (const lod of lods) {
        const cur = lod.currentLevelIdx;
        const key = cur === lod.levels.length - 1 ? "culled" : `lod${cur}`;
        h[key] = (h[key] || 0) + 1;
      }
      return h;
    },
    census: () => {
      let trisNow = 0, trisLod0 = 0;
      for (const lod of lods) {
        trisLod0 += trisOfObject(lod.levels[0].object);
        trisNow += trisOfObject(lod.levels[lod.currentLevelIdx].object);
      }
      return { trisNow, trisLod0 };
    },
  };
  if (typeof window !== "undefined") window.__bazaarLod = handle;
  return handle;
}
