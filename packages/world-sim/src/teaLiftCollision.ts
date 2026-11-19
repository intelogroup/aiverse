import { Vector3, type Mesh } from "three";
import { boxesMesh, NO_GROUND } from "./capsuleWorld";
import { TEA_FLOORS } from "./teaBuilding";
import { LIFT, type TeaElevatorController } from "./teaElevator";

/** Server collision for the same cabin, sill, and door interlock as the rendered lift. */
export function teaLiftCollision(controller: TeaElevatorController) {
  const pieces: { mesh: Mesh; floor: number | null; gate: boolean }[] = [];
  function add(
    name: string, box: [number, number, number, number, number, number, number],
    floor: number | null, ground = false, gate = false,
  ) {
    const mesh = boxesMesh([box], [0, 0], name)!;
    mesh.userData[NO_GROUND] = !ground;
    mesh.userData.collisionOffset = new Vector3();
    pieces.push({ mesh, floor, gate });
  }
  const z = (LIFT.front + LIFT.back) / 2;
  add("cabin-floor", [LIFT.x, z, .9, 1.15, -.14, 0, 0], null, true);
  add("cabin-rear", [LIFT.x, LIFT.back - .05, .9, .05, 0, 2.2, 0], null);
  for (const side of [-1, 1]) {
    add("cabin-side", [LIFT.x + side * .85, z, .05, 1.1, 0, 2.2, 0], null);
  }
  add("cabin-gate", [LIFT.x, LIFT.front, .55, .04, 0, 2.2, 0], null, false, true);
  for (const floor of TEA_FLOORS.keys()) {
    add("lift-sill", [LIFT.x, LIFT.doorZ, .55, .16, -.12, 0, 0], floor, true);
    add("lift-landing-gate", [LIFT.x, LIFT.doorZ, .55, .05, 0, 2.2, 0], floor, false, true);
  }
  return {
    meshes: pieces.map(({ mesh }) => mesh),
    update() {
      for (const { mesh, floor, gate } of pieces) {
        (mesh.userData.collisionOffset as Vector3).y = floor === null ? controller.y : TEA_FLOORS[floor]!.y;
        mesh.userData.collisionDisabled = gate && controller.canPass(floor ?? controller.floor);
      }
    },
  };
}
