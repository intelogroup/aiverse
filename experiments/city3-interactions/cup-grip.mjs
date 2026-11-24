import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AnimationMixer, CylinderGeometry, Group, LoopOnce, Mesh, MeshStandardMaterial, Texture, Vector3,
} from "../../apps/console/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../../apps/console/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

const MAX_REACH_M = 0.1;
const CUP_HEIGHT_M = 0.12;
const FIGURES = ["summer", "remy", "cipher", "eve", "elf", "jim"];
const loader = new GLTFLoader();
loader.register(() => ({ name: "audit-texture-placeholder", loadTexture: async () => new Texture() }));

function cupMesh() {
  const group = new Group();
  const material = new MeshStandardMaterial({ color: 0x6bafc4, roughness: 0.3 });
  const sides = new Mesh(new CylinderGeometry(0.038, 0.031, CUP_HEIGHT_M, 24, 1, true), material);
  const bottom = new Mesh(new CylinderGeometry(0.032, 0.032, 0.006, 24), material);
  sides.position.y = CUP_HEIGHT_M / 2;
  bottom.position.y = 0.003;
  group.add(sides, bottom);
  return group;
}

// The cup stays a single object as ownership moves between table and hand.
class Cup {
  constructor(table, gripAtRest) {
    this.table = table;
    this.home = gripAtRest.clone().add(new Vector3(0, -CUP_HEIGHT_M / 2, 0));
    this.mesh = cupMesh();
    this.actor = null;
    this.reset();
  }

  reset() {
    this.table.add(this.mesh);
    this.mesh.position.copy(this.home);
    this.mesh.rotation.set(0, 0, 0);
    this.mesh.scale.setScalar(1);
    this.actor = null;
    this.table.updateMatrixWorld(true);
  }

  gripPoint() {
    return this.mesh.localToWorld(new Vector3(0, CUP_HEIGHT_M / 2, 0));
  }

  take(actor, hand) {
    if (this.actor !== null || hand.getWorldPosition(new Vector3()).distanceTo(this.gripPoint()) > MAX_REACH_M) return false;
    hand.attach(this.mesh);
    this.actor = actor;
    return true;
  }

  putDown(actor) {
    if (this.actor !== actor || this.gripPoint().distanceTo(this.table.localToWorld(
      this.home.clone().add(new Vector3(0, CUP_HEIGHT_M / 2, 0)),
    )) > MAX_REACH_M) return false;
    this.reset();
    return true;
  }

  cancel(actor) {
    if (this.actor === actor) this.reset();
  }
}

async function loadFigure(figure) {
  const path = new URL(`../../apps/console/public/assets/cast-${figure}.glb`, import.meta.url);
  const buf = await readFile(path);
  return loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
}

const results = [];
let sharedMarker;
for (const figure of FIGURES) {
  const { scene, animations } = await loadFigure(figure);
  const stage = new Group();
  stage.add(scene);
  let hand, head;
  scene.traverse(node => {
    if (!node.isBone) return;
    if (/lefthand$/i.test(node.name)) hand = node;
    if (/head$/i.test(node.name)) head = node;
  });
  const clip = animations.find(animation => animation.name === "Drinking");
  assert.ok(hand && head && clip);
  const mixer = new AnimationMixer(scene);
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  function pose(t) {
    mixer.setTime(t);
    stage.updateMatrixWorld(true);
  }

  action.play();
  pose(0);
  const fittedMarker = hand.getWorldPosition(new Vector3());
  sharedMarker ??= fittedMarker.clone();
  const sharedMarkerGapM = fittedMarker.distanceTo(sharedMarker);
  const cup = new Cup(stage, fittedMarker);
  const farHand = new Group();
  farHand.position.copy(fittedMarker).add(new Vector3(2, 0, 0));
  stage.add(farHand);
  assert.equal(cup.take("visitor", farHand), false);
  for (const hz of [20, 30, 60]) {
    action.reset().play();
    pose(0);
    const beforeGrip = cup.gripPoint();
    assert.equal(cup.take("visitor", hand), true);
    assert.equal(cup.take("other visitor", hand), false);
    assert.equal(cup.putDown("other visitor"), false);
    const pickupJumpM = cup.gripPoint().distanceTo(beforeGrip);
    let gripDriftM = 0, nearestRimToHeadM = Infinity, cupTravelM = 0;
    let rejectedEarlyRelease = false;
    for (let frame = 0; frame <= Math.ceil(clip.duration * hz); frame++) {
      pose(Math.min(clip.duration - 0.0001, frame / hz));
      const grip = cup.gripPoint();
      gripDriftM = Math.max(gripDriftM, grip.distanceTo(hand.getWorldPosition(new Vector3())));
      nearestRimToHeadM = Math.min(nearestRimToHeadM,
        cup.mesh.localToWorld(new Vector3(0, CUP_HEIGHT_M, 0)).distanceTo(head.getWorldPosition(new Vector3())));
      cupTravelM = Math.max(cupTravelM, grip.distanceTo(beforeGrip));
      if (!rejectedEarlyRelease && grip.distanceTo(beforeGrip) > MAX_REACH_M + 0.01) {
        rejectedEarlyRelease = !cup.putDown("visitor");
      }
    }
    const returnGapM = cup.gripPoint().distanceTo(beforeGrip);
    const putDown = cup.putDown("visitor");
    if (!putDown) cup.cancel("visitor");
    assert.equal(cup.actor, null);
    assert.equal(cup.mesh.parent, stage);
    assert.ok(pickupJumpM < 0.00001 && gripDriftM < 0.00001 && cupTravelM > 0.1 && rejectedEarlyRelease);
    results.push({ figure, hz, sharedMarkerGapM, pickupJumpM, gripDriftM, nearestRimToHeadM,
      cupTravelM, returnGapM, putDown, rejectedEarlyRelease });
  }
  action.reset().play();
  pose(0);
  assert.equal(cup.take("visitor", hand), true);
  pose(3);
  cup.cancel("visitor");
  assert.equal(cup.actor, null);
  assert.equal(cup.mesh.parent, stage);
}
console.log(JSON.stringify(results, null, 2));
