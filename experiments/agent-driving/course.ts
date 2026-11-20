import * as THREE from "three";
import { COURSE } from "./protocol";
import { isIntersectionLesson, LESSON_ROAD, type LessonState } from "./lessons";
import { benchmarkCase } from "./benchmark";

function texturedSurface(color: string, seed: number, repeats: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 192, 192);
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 8700; i++) {
    ctx.fillStyle = random() > 0.54 ? "#e6ddaa16" : "#070b0b24";
    const size = 0.5 + random() * 2;
    ctx.fillRect(random() * 192, random() * 192, size, size);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeats, repeats);
  map.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map, roughness: 0.94 });
}

const standard = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.84 });

export function buildCourse() {
  const group = new THREE.Group();
  const ground = (width: number, length: number, y: number, material: THREE.Material, x = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const asphalt = texturedSurface("#505253", 91, 12);
  const crossAsphalt = asphalt.clone();
  crossAsphalt.map = asphalt.map!.clone();
  crossAsphalt.map.repeat.set(22, 3);
  asphalt.map!.repeat.set(4, 27);
  const gravel = texturedSurface("#817d6b", 85, 15);
  ground(410, 410, -0.105, texturedSurface("#646846", 23, 120));
  ground(15.8, 96, -0.035, gravel, 0, 8);
  const crossingGravel = ground(68, 11.6, -0.036, gravel, 0, COURSE.crossingZ);
  ground(13.1, 96, -0.008, asphalt, 0, 8);
  const crossingAsphalt = ground(69, 8, -0.007, crossAsphalt, 0, COURSE.crossingZ);
  const routeApproach = new THREE.Group();
  routeApproach.add(ground(15.8, 24, -0.035, gravel, 0, -52), ground(13.1, 24, -0.008, asphalt, 0, -52));
  group.add(routeApproach);

  const originalMarks = new THREE.Group();
  const crossingEdges = new THREE.Group();
  const crossBarriers = new THREE.Group();
  const southBarriers = new THREE.Group();
  const mainEdges: THREE.Mesh[] = [];
  const white = standard(0xf4efd8);
  const amber = standard(0xe7ac58);
  const nearLength = COURSE.crossingZ - COURSE.crossingHalfWidth - COURSE.south + 2;
  const farLength = COURSE.north + 3 - COURSE.crossingZ - COURSE.crossingHalfWidth;
  for (const side of [-1, 1]) {
    mainEdges.push(ground(0.12, nearLength, 0.002, white, 5.95 * side, COURSE.crossingZ - COURSE.crossingHalfWidth - nearLength / 2));
    mainEdges.push(ground(0.12, farLength, 0.002, white, 5.95 * side, COURSE.crossingZ + COURSE.crossingHalfWidth + farLength / 2));
    for (const x of [-19.8, 19.8]) crossingEdges.add(ground(27.4, 0.105, 0.002, white, x, COURSE.crossingZ + side * 3.65));
    for (const z of [-28, -18, -8, 17, 27, 37, 47]) originalMarks.add(ground(0.155, 4.8, 0.002, amber, 0.12 * side, z));
  }

  for (let x = 0.65; x < 5.7; x += 0.94) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([
      x - 0.23, 0.006, COURSE.yieldLineZ - 0.28,
      x - 0.23, 0.006, COURSE.yieldLineZ + 0.27,
      x + 0.28, 0.006, COURSE.yieldLineZ,
    ], 3)), white);
    originalMarks.add(mesh);
  }

  const post = standard(0x5f655e);
  const concrete = standard(0xa9aa95);
  const black = standard(0x262926);
  const vermilion = standard(0xad3423);
  for (const [x, z, width] of [[0, 55, 12.9], [0, -39.5, 12.9], [-34.9, 8, 9.2], [34.9, 8, 9.2]]) {
    const yaw = x !== 0 ? Math.PI / 2 : 0;
    for (let offset = -width / 2 + 0.55; offset < width / 2; offset += 1.6) {
      const barrier = box(1.4, 0.68, 0.36, x + Math.cos(yaw) * offset, 0.31, z + Math.sin(yaw) * offset, concrete);
      barrier.rotation.y = yaw;
      const reflector = box(1.05, 0.09, 0.38, barrier.position.x, 0.45, barrier.position.z, offset > 0 ? vermilion : amber);
      reflector.rotation.y = yaw;
      if (x !== 0) crossBarriers.add(barrier, reflector);
      else if (z < 0) southBarriers.add(barrier, reflector);
    }
  }
  for (const x of [-7.2, 7.2]) {
    for (const z of [-31, -16, -1, 17, 31, 47]) {
      box(0.14, 0.91, 0.17, x, 0.4, z, concrete);
      box(0.155, 0.14, 0.18, x, 0.67, z, black);
    }
  }
  originalMarks.add(box(0.08, 2.65, 0.08, 6.76, 1.27, COURSE.yieldLineZ, post));
  const triangle = new THREE.Shape();
  triangle.moveTo(-0.48, 0.32);
  triangle.lineTo(0.48, 0.32);
  triangle.lineTo(0, -0.46);
  triangle.closePath();
  const sign = new THREE.Mesh(new THREE.ShapeGeometry(triangle), vermilion);
  sign.position.set(6.76, 2.36, COURSE.yieldLineZ - 0.056);
  sign.rotation.y = Math.PI;
  originalMarks.add(sign);
  const inset = new THREE.Mesh(sign.geometry, white);
  inset.scale.setScalar(0.74);
  inset.position.z = 0.005;
  sign.add(inset);
  group.add(originalMarks, crossingEdges, southBarriers, crossBarriers);

  const brokenWhite = new THREE.Group();
  for (let z = -35; z < 51; z += 7) brokenWhite.add(ground(0.13, 3.4, 0.003, white, 0, z));
  const threePointCurbs = new THREE.Group();
  for (const x of [-LESSON_ROAD.curb, LESSON_ROAD.curb]) threePointCurbs.add(box(0.15, 0.15, 50, x * 1.014, 0, -12, concrete));
  const intersectionMarks = new THREE.Group();
  const crossingCenter = new THREE.Group();
  for (const x of [-0.12, 0.12]) {
    intersectionMarks.add(ground(0.12, 40, 0.003, amber, x, -17));
    intersectionMarks.add(ground(0.12, 37, 0.003, amber, x, 31));
  }
  for (const z of [COURSE.crossingZ - 0.12, COURSE.crossingZ + 0.12]) {
    for (const x of [-20.3, 20.3]) crossingCenter.add(ground(27.4, 0.12, 0.003, amber, x, z));
  }
  const stopLine = ground(5.85, 0.31, 0.004, white, -3, COURSE.yieldLineZ);
  const arrows = new THREE.Group();
  const straightArrow = [[-0.16, 0], [0.16, 0], [0.16, 1.13], [0.46, 1.13], [0, 1.83], [-0.46, 1.13], [-0.16, 1.13]];
  const rightArrow = [[0.16, 0], [-0.16, 0], [-0.16, 0.95], [-0.52, 0.95], [-0.52, 0.63],
    [-1.2, 1.13], [-0.52, 1.65], [-0.52, 1.32], [0.16, 1.32]];
  for (const [x, points] of [[LESSON_ROAD.laneCenter, straightArrow], [-LESSON_ROAD.laneCenter, rightArrow]] as const) {
    const shape = new THREE.Shape(points.map(([px, pz]) => new THREE.Vector2(px, -pz)));
    const geometry = new THREE.ShapeGeometry(shape);
    for (const z of [-36, -23, -11]) {
      const arrow = new THREE.Mesh(geometry, white);
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(x, 0.008, z);
      arrow.scale.set(1.5, 2.25, 1);
      arrows.add(arrow);
    }
  }
  for (const z of [-57, -50, -43]) routeApproach.add(ground(0.13, 3.4, 0.003, white, 0, z));
  const crosswalk = new THREE.Group();
  for (let z = 4.3; z <= 11.8; z += 0.67) crosswalk.add(ground(2.15, 0.37, 0.006, white, LESSON_ROAD.crosswalkX, z));
  group.add(brokenWhite, threePointCurbs, intersectionMarks, crossingCenter, crosswalk, arrows);

  function roadSign(lines: string[], stop: boolean, x: number, z: number) {
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    root.rotation.y = Math.PI;
    root.add(new THREE.Mesh(new THREE.BoxGeometry(0.085, 2.75, 0.085), post));
    root.children[0].position.y = 1.38;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = stop ? 256 : 216;
    const ctx = canvas.getContext("2d")!;
    const shape = new THREE.Shape();
    if (stop) {
      const points = [[0, 69], [69, 0], [187, 0], [256, 69], [256, 187], [187, 256], [69, 256], [0, 187]];
      for (const [i, [px, py]] of points.entries()) {
        if (i === 0) shape.moveTo(px / 256 - 0.5, 0.5 - py / 256);
        else shape.lineTo(px / 256 - 0.5, 0.5 - py / 256);
      }
      shape.closePath();
      ctx.fillStyle = "#b42027";
    } else ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!stop) {
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 6;
      ctx.strokeRect(7, 7, 242, 202);
    }
    ctx.fillStyle = stop ? "#fff" : "#101010";
    ctx.font = `bold ${stop ? 83 : 59}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((line, i) => ctx.fillText(line, 128, canvas.height / 2 + (i - (lines.length - 1) / 2) * 61));
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(stop ? 1 : 1.65, stop ? 1 : 1.39), new THREE.MeshBasicMaterial({ map }));
    if (stop) {
      const clip = document.createElement("canvas");
      clip.width = clip.height = 256;
      const mask = clip.getContext("2d")!;
      mask.translate(128, 128);
      mask.scale(256, -256);
      mask.beginPath();
      shape.getPoints().forEach((p, i) => i ? mask.lineTo(p.x, p.y) : mask.moveTo(p.x, p.y));
      mask.fill();
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(clip, 0, 0);
      face.material.transparent = true;
    }
    face.position.set(0, 2.46, 0.055);
    root.add(face);
    group.add(root);
    return root;
  }
  const stopSign = roadSign(["STOP"], true, LESSON_ROAD.signX, 3.1);
  const redSign = roadSign(["NO TURN", "ON RED"], false, LESSON_ROAD.signX, 4.3);
  const signal = new THREE.Group();
  const signalX = -4;
  const signalZ = 12.8;
  signal.add(box(0.13, 4.65, 0.13, -6.3, 2.28, signalZ, post));
  signal.add(box(2.45, 0.12, 0.13, -5.14, 4.57, signalZ, post));
  signal.add(box(0.66, 1.55, 0.34, signalX, 4, signalZ, black));
  const lamps = [0xf82825, 0xf0bb32, 0x27ed54].map((color, i) => {
    const material = new THREE.MeshStandardMaterial({ color: 0x151616, emissive: color, emissiveIntensity: 0.05 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), material);
    mesh.scale.z = 0.45;
    mesh.position.set(signalX, 4.46 - i * 0.46, signalZ - 0.185);
    signal.add(mesh);
    return material;
  });
  group.add(signal);

  const moss = [0x737957, 0x687455, 0x525f49, 0x58624a];
  for (let i = 0; i < 21; i++) {
    const angle = (i / 21) * Math.PI * 2;
    const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), standard(moss[i % moss.length]));
    hill.scale.set(27 + (i % 4) * 8, 7 + (i % 5) * 3.1, 23 + (i % 3) * 8);
    hill.position.set(Math.cos(angle) * (115 + i % 4 * 4), -4, Math.sin(angle) * (119 + i % 3 * 6));
    hill.rotation.y = angle;
    group.add(hill);
  }

  const treeCount = 88;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.19, 1.7, 6), standard(0x665941), treeCount);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), standard(0xffffff), treeCount);
  const matrix = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < treeCount; i++) {
    const angle = i * 2.399963;
    const x = Math.cos(angle) * (32 + i % 8 * 3.2);
    const z = Math.sin(angle) * (44 + i % 7 * 3.8) - 3;
    const size = 0.75 + (i % 11) / 11;
    matrix.position.set(Math.abs(x) < 10 ? x + 13 : x, size * 0.83, Math.abs(z - COURSE.crossingZ) < 7 ? z + 13 : z);
    matrix.rotation.y = angle;
    matrix.scale.setScalar(size);
    matrix.updateMatrix();
    trunks.setMatrixAt(i, matrix.matrix);
    matrix.position.y = 2.1 * size;
    matrix.scale.set(size * 1.22, size * 1.47, size * 1.34);
    matrix.updateMatrix();
    crowns.setMatrixAt(i, matrix.matrix);
    crowns.setColorAt(i, tint.set(moss[i % moss.length]).multiplyScalar(0.72 + (i % 9) * 0.045));
  }
  group.add(trunks, crowns);
  return {
    root: group,
    update(lesson?: LessonState) {
      const junction = !lesson || isIntersectionLesson(lesson.id);
      const course = lesson?.benchmark ? benchmarkCase(lesson.benchmark) : undefined;
      const shift = course?.shift ?? 0;
      const route = course?.chapter === "route";
      routeApproach.visible = arrows.visible = route;
      southBarriers.visible = !route;
      crossBarriers.position.z = crossingEdges.position.z = crossingCenter.position.z = shift;
      crossingGravel.position.z = crossingAsphalt.position.z = COURSE.crossingZ + shift;
      for (const [i, line] of mainEdges.entries()) {
        const near = i % 2 === 0;
        const length = near ? nearLength : farLength;
        line.scale.y = (length + (near ? shift : -shift) + (near && route ? 24 : 0)) / length;
        const origin = COURSE.crossingZ + shift + (near ? -COURSE.crossingHalfWidth : COURSE.crossingHalfWidth);
        line.position.z = origin + (near ? -1 : 1) * length * line.scale.y / 2;
      }
      crossingCenter.visible = stopLine.visible = Boolean(lesson && junction);
      stopLine.position.z = COURSE.yieldLineZ + shift + (course?.stopOffset ?? 0);
      stopLine.scale.x = route ? 2 : 1;
      stopLine.position.x = route ? 0 : -3;
      arrows.position.z = shift;
      intersectionMarks.position.z = shift;
      redSign.position.x = course?.signX ?? LESSON_ROAD.signX;
      redSign.position.z = (course?.signZ ?? 4.3) + shift;
      signal.position.set(course?.signalX ?? 0, 0, shift);
      crosswalk.position.set((course?.crosswalkX ?? LESSON_ROAD.crosswalkX) - LESSON_ROAD.crosswalkX, 0, shift);
      crossingGravel.visible = crossingAsphalt.visible = crossingEdges.visible = junction;
      originalMarks.visible = !lesson;
      brokenWhite.visible = lesson?.laneDivider === "broken_white";
      threePointCurbs.visible = lesson?.id === "three_point";
      intersectionMarks.visible = Boolean(lesson && junction && !route);
      stopSign.visible = lesson?.sign === "STOP";
      redSign.visible = lesson?.sign === "NO TURN ON RED";
      signal.visible = Boolean(lesson?.signalHead);
      crosswalk.visible = lesson?.crosswalk === true;
      lamps[0].emissiveIntensity = lesson?.signalHead === "red" ? 2.6 : 0;
      lamps[1].emissiveIntensity = lesson?.signalHead === "yellow" ? 2.6 : 0;
      lamps[2].emissiveIntensity = lesson?.signalHead === "green" ? 2.4 : 0;
    },
  };
}
