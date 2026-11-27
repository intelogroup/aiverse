// Fits every finger-rigged agent body's apple grip and writes packages/world-sim/src/appleFits.generated.ts.
// Run from apps/console after changing a cast GLB, APPLE_SIZE or a stand:  bun scripts/fit-apple-grips.ts
//
// Remy's grip is the Blender calibration (REMY_APPLE_GRIP) and the reference. Every other body's grip is searched on a 4 mm grid
// around it so that, at each stand's contact frame, the gap from each hand part (palm, thumb, fingers) to the apple's skin matches
// Remy's gap for that part. The apple is a sphere for the search; tests/apple-grip-bodies.test.ts re-checks against its real mesh.
import { readFileSync, writeFileSync } from "node:fs";
import { AnimationMixer, LoopOnce, type Matrix4, type Object3D, SkinnedMesh, Texture, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BODIES, BODY_REMY, type BodyDef } from "@aiverse/world-sim/bodies";
import { APPLE_STANDS, type AppleStand } from "@aiverse/world-sim/movableProps";
import { APPLE_SIZE, REMY_APPLE_GRIP, REMY_HAND_WORLD_SCALE } from "../src/features/world/appleGrip";

export const CLIPS: Record<AppleStand, string> = { "apple-stand-01": "PickUp", "apple-stand-02": "PuttingDown" };
const PARTS = ["Palm", "Thumb", "Index", "Middle", "Ring", "Pinky"];
const APPLE_RADIUS = 0.029 * APPLE_SIZE; // m, the sphere standing in for the apple during the search
const STEP = 0.004 / REMY_HAND_WORLD_SCALE; // 4 mm, in Remy hand units
const REACH = 14; // grid steps each way

export const assetUrl = (path: string) => new URL(`../public${path}`, import.meta.url);

export async function load(url: URL) {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: "t", loadTexture: async () => new Texture() }));
  return loader.parseAsync(Uint8Array.from(readFileSync(url)).buffer, "");
}

/** Right-hand vertices in world space at the scene's current pose, tagged by hand part (the bone carrying most of the weight). */
export function handVertices(scene: Object3D): [string, Vector3][] {
  const out: [string, Vector3][] = [];
  scene.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    o.skeleton.update();
    const { position, skinIndex, skinWeight } = o.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      let bone = 0;
      for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, bone)) bone = k;
      const part = /^mixamorigRightHand(Thumb|Index|Middle|Ring|Pinky)?\d?$/.exec(o.skeleton.bones[skinIndex.getComponent(i, bone)]?.name ?? "");
      if (part) out.push([part[1] ?? "Palm", o.applyBoneTransform(i, new Vector3().fromBufferAttribute(position, i)).applyMatrix4(o.matrixWorld)]);
    }
  });
  return out;
}

/** A rig the finger fit applies to: thumb, index, middle, ring and pinky, three joints each, on the right hand. */
export const fingerRig = (boneNames: string[]) => boneNames.filter((n) => /^mixamorigRightHand(Thumb|Index|Middle|Ring|Pinky)[1-3]$/.test(n)).length === 15;

interface Pose { stand: AppleStand; hand: Matrix4; units: number; pts: [string, Vector3][] }

async function contactPoses(body: BodyDef): Promise<{ poses: Pose[]; bones: string[] }> {
  const { scene, animations } = await load(assetUrl(body.url));
  scene.scale.setScalar(body.scale);
  const hand = scene.getObjectByName("mixamorigRightHand")!;
  const bones: string[] = [];
  scene.traverse((o) => { if ((o as { isBone?: boolean }).isBone) bones.push(o.name); });
  const poses: Pose[] = [];
  let mixer: AnimationMixer | undefined;
  for (const stand of Object.keys(APPLE_STANDS) as AppleStand[]) {
    const clip = animations.find((a) => a.name === CLIPS[stand]);
    if (!clip) return { poses: [], bones };
    mixer?.stopAllAction(); // a second live mixer on the same scene would blend its pose in
    mixer = new AnimationMixer(scene);
    mixer.clipAction(clip).setLoop(LoopOnce, 1).play();
    mixer.setTime(APPLE_STANDS[stand].contact);
    scene.updateMatrixWorld(true);
    poses.push({ stand, hand: hand.matrixWorld.clone(), units: REMY_HAND_WORLD_SCALE / hand.getWorldScale(new Vector3()).x, pts: handVertices(scene) });
  }
  return { poses, bones };
}

const worldGrip = (p: Pose, grip: Vector3) => grip.clone().multiplyScalar(p.units).applyMatrix4(p.hand);

function gapProfile(p: Pose, grip: Vector3): Record<string, number> {
  const g = worldGrip(p, grip), best: Record<string, number> = {};
  for (const [part, v] of p.pts) best[part] = Math.min(best[part] ?? Infinity, v.distanceTo(g) - APPLE_RADIUS);
  return best;
}

function fitGrip(poses: Pose[], ref: Record<string, Record<string, number>>): Vector3 {
  const cost = (grip: Vector3) => {
    let c = 0;
    for (const p of poses) {
      const gaps = gapProfile(p, grip);
      for (const part of PARTS) {
        const gap = gaps[part] ?? 0, want = ref[p.stand][part] ?? 0;
        c += (gap - want) ** 2 + (gap < -0.003 ? 100 * (gap + 0.003) ** 2 : 0); // sinking a part into the apple costs extra
      }
    }
    return c;
  };
  const base = new Vector3(...REMY_APPLE_GRIP);
  let best = base, bestCost = Infinity;
  for (let x = -REACH; x <= REACH; x++) for (let y = -REACH; y <= REACH; y++) for (let z = -REACH; z <= REACH; z++) {
    const grip = new Vector3(x, y, z).multiplyScalar(STEP).add(base), c = cost(grip);
    if (c < bestCost) { bestCost = c; best = grip; }
  }
  return best;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

async function main() {
  const remy = await contactPoses(BODY_REMY);
  const remyGrip = new Vector3(...REMY_APPLE_GRIP);
  const ref = Object.fromEntries(remy.poses.map((p) => [p.stand, gapProfile(p, remyGrip)]));
  const fits: Record<string, unknown> = {};
  for (const body of Object.values(BODIES).filter((b) => b.agentBody !== false)) {
    const { poses, bones } = body.id === "remy" ? remy : await contactPoses(body);
    if (!poses.length || !fingerRig(bones)) { console.log(`${body.id}: skipped (${poses.length ? "no finger rig" : "no PickUp/PuttingDown"})`); continue; }
    const grip = body.id === "remy" ? remyGrip : fitGrip(poses, ref);
    const entry: Record<string, unknown> = { scale: body.scale, grip: body.id === "remy" ? [...REMY_APPLE_GRIP] : grip.toArray().map(round) };
    for (const p of poses) {
      const g = worldGrip(p, grip), { offset } = APPLE_STANDS[p.stand];
      // Remy's stance is the stand's own (its offset is Remy's Blender-swept grip), so his entry stays exact.
      entry[p.stand] = body.id === "remy" ? [offset[0], offset[2]] : [round(g.x / body.scale), round(g.z / body.scale)];
    }
    fits[body.id] = entry;
    console.log(`${body.id}: grip ${JSON.stringify(entry.grip)}`);
  }
  const list = (v: unknown) => `[${(v as number[]).join(", ")}]`;
  const rows = Object.entries(fits).map(([id, e]) => `  ${id}: { ${Object.entries(e as object).map(([k, v]) => `${k.includes("-") ? `"${k}"` : k}: ${Array.isArray(v) ? list(v) : v}`).join(", ")} },`);
  writeFileSync(new URL("../../../packages/world-sim/src/appleFits.generated.ts", import.meta.url), [
    "// GENERATED by apps/console/scripts/fit-apple-grips.ts. Do not edit: rerun it after changing a cast GLB, APPLE_SIZE or a stand.",
    "/** Per body: display scale, apple centre in the right-hand frame (Remy hand units), and that grip's x/z at each stand's contact frame (rig units, heading 0). */",
    "export const APPLE_FITS = {",
    ...rows,
    "} as const;",
    "",
  ].join("\n"));
}

if (import.meta.main) await main();
