import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const TEA_HOUSE_RADIO_ASSET = "tea_house_radio";

let radio: THREE.Group | undefined;

/** A tabletop receiver in metres, with its feet at Y=0 and controls facing +Z. */
export function teaHouseRadio(): THREE.Group {
  if (radio) return radio;

  const parts = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
  const walnut = new THREE.MeshStandardMaterial({ color: 0x583525, roughness: 0.62 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x996445, roughness: 0.5 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc5a168, roughness: 0.38, metalness: 0.55 });
  const bakelite = new THREE.MeshStandardMaterial({ color: 0x312421, roughness: 0.55 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x7d6b52, roughness: 1 });
  const dial = new THREE.MeshStandardMaterial({ color: 0xe1c99a, roughness: 0.5 });
  const needle = new THREE.MeshStandardMaterial({ color: 0x953d2f, roughness: 0.55 });

  function add(material: THREE.MeshStandardMaterial, geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
    geometry.translate(x, y, z);
    const meshes = parts.get(material) ?? [];
    meshes.push(geometry);
    parts.set(material, meshes);
  }

  function box(material: THREE.MeshStandardMaterial, w: number, h: number, d: number, x: number, y: number, z: number) {
    add(material, new THREE.BoxGeometry(w, h, d).toNonIndexed(), x, y, z);
  }

  function cabinet(material: THREE.MeshStandardMaterial, w: number, h: number, depth: number, radius: number, y: number, z: number) {
    const profile = new THREE.Shape();
    profile.moveTo(radius, 0);
    profile.lineTo(w - radius, 0);
    profile.quadraticCurveTo(w, 0, w, radius);
    profile.lineTo(w, h - radius);
    profile.quadraticCurveTo(w, h, w - radius, h);
    profile.lineTo(radius, h);
    profile.quadraticCurveTo(0, h, 0, h - radius);
    profile.lineTo(0, radius);
    profile.quadraticCurveTo(0, 0, radius, 0);
    add(material, new THREE.ExtrudeGeometry(profile, { depth, bevelEnabled: false, curveSegments: 5 }), -w / 2, y, z);
  }

  function knob(material: THREE.MeshStandardMaterial, radius: number, depth: number, x: number, y: number, z: number) {
    const cylinder = new THREE.CylinderGeometry(radius, radius, depth, 20).toNonIndexed();
    add(material, cylinder.rotateX(Math.PI / 2), x, y, z);
  }

  cabinet(walnut, 0.42, 0.258, 0.284, 0.029, 0.012, -0.116);
  cabinet(trim, 0.402, 0.237, 0.007, 0.024, 0.024, 0.168);
  cabinet(bakelite, 0.369, 0.202, 0.007, 0.015, 0.04, 0.175);
  for (const x of [-0.15, 0.15]) {
    for (const z of [-0.077, 0.123]) box(bakelite, 0.046, 0.012, 0.043, x, 0.006, z);
  }

  box(cloth, 0.164, 0.146, 0.004, -0.085, 0.145, 0.184);
  for (let i = 0; i < 8; i++) box(brass, 0.168, 0.003, 0.004, -0.085, 0.082 + i * 0.018, 0.188);
  box(brass, 0.148, 0.059, 0.005, 0.092, 0.183, 0.185);
  box(dial, 0.136, 0.046, 0.003, 0.092, 0.183, 0.189);
  for (let i = 0; i < 11; i++) {
    const height = i % 5 === 0 ? 0.012 : 0.007;
    box(bakelite, 0.002, height, 0.001, 0.037 + i * 0.011, 0.171 + height / 2, 0.191);
  }
  box(needle, 0.003, 0.034, 0.001, 0.106, 0.183, 0.192);
  for (const x of [0.047, 0.116]) {
    knob(brass, 0.022, 0.005, x, 0.099, 0.185);
    knob(bakelite, 0.018, 0.014, x, 0.099, 0.195);
    box(brass, 0.002, 0.009, 0.001, x, 0.107, 0.203);
  }
  // The interaction visual adds the powered bead at the centre of this bezel.
  knob(brass, 0.013, 0.006, 0.158, 0.099, 0.185);

  radio = new THREE.Group();
  radio.name = `LIB_${TEA_HOUSE_RADIO_ASSET}`;
  for (const [material, geometries] of parts) {
    const geometry = mergeGeometries(geometries)!;
    for (const part of geometries) part.dispose();
    radio.add(new THREE.Mesh(geometry, material));
  }
  return radio;
}
