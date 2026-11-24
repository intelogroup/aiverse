// @vitest-environment node
import { expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";

it("charges for actual movement, stops exhausted movement and restores energy with rest", async () => {
  const { sim } = await loadVerseSim(new URL("../public/assets/", import.meta.url).pathname);
  const service = new WorldService({ sim, movementEnergy: true, leaseS: 1000 });
  service.attach("runner", { x: -22.9, z: -68 });
  for (let leg = 0; leg < 100 && !service.observe("runner").energy!.exhausted; leg++) {
    const id = `run-${leg}`;
    service.act("runner", id, { type: "run_to", point: [-22.9, leg % 2 ? -68 : -60] });
    for (let step = 0; step < 300 && service.actRecord("runner", id)?.state === "running"; step++) {
      service.tick(0.05);
      await Promise.resolve();
    }
  }
  expect(service.observe("runner").energy).toMatchObject({ exhausted: true });
  expect(service.act("runner", "exhausted", { type: "go_to", point: [-22.9, -60] }).outcome?.detail).toMatch(/rest/);
  for (let step = 0; step < 250; step++) {
    service.tick(0.05);
    await Promise.resolve();
  }
  expect(service.observe("runner").energy).toMatchObject({ exhausted: false });
});
