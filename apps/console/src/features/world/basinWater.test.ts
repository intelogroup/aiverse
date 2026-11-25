import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { installLidoWater } from "./basinWater";

describe("Lido water material", () => {
  it("replaces only the Lido GLB material and restores cached geometry on teardown", () => {
    const oldWater = new THREE.MeshStandardMaterial({ name: "BzOpen_water", transparent: true });
    const stone = new THREE.MeshStandardMaterial({ name: "BzOpen_stone" });
    const sea = new THREE.MeshStandardMaterial({ name: "sea" });
    const geometry = new THREE.PlaneGeometry();
    const pool = new THREE.Mesh(geometry, [stone, oldWater]);
    const poolPart = new THREE.Mesh(geometry, oldWater);
    const ocean = new THREE.Mesh(geometry, sea);
    const scene = new THREE.Group().add(pool, poolPart, ocean);
    pool.castShadow = true;

    const restore = installLidoWater(scene, { value: 0 });
    expect(pool.geometry).toBe(geometry);
    expect(pool.material[0]).toBe(stone);
    expect(pool.material[1]).toBe(poolPart.material);
    expect(poolPart.material).toMatchObject({ name: "City3BasinWater", ior: 1.333, transmission: 0 });
    expect(ocean.material).toBe(sea);
    expect(pool.castShadow).toBe(false);
    const dispose = vi.fn();
    poolPart.material.addEventListener("dispose", dispose);

    restore();

    expect(pool.material).toEqual([stone, oldWater]);
    expect(poolPart.material).toBe(oldWater);
    expect(pool.castShadow).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
