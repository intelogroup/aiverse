import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
import { agentBodies } from "../../packages/world-sim/src/bodies";
import { WorldService } from "../../packages/world-sim/src/worldService";

const assets = new URL("../../apps/console/public/assets/", import.meta.url).pathname;
const { sim } = await loadVerseSim(assets);
const rows = [];
for (const dt of [1 / 60, 1 / 30, 1 / 20]) {
  for (const figure of agentBodies()) {
    const world = new WorldService({ sim });
    const actor = "stress";
    let serial = 0;
    async function run(label: string, action: Record<string, unknown>) {
      const before = world.body(actor);
      const request = world.act(actor, String(++serial), action);
      const clips = new Set<string>();
      let visible = false;
      const n = world.roster().bodies.find(b => b.agentId === actor)!.n;
      for (let t = 0; t < 40; t += dt) {
        const clip = world.body(actor).clip;
        if (clip) clips.add(clip);
        visible ||= world.frames().b.some(pose => pose[0] === n);
        if (request.state === "settled") break;
        world.tick(dt);
        await Promise.resolve();
      }
      const after = world.body(actor);
      rows.push({ hz: Math.round(1 / dt), figure: figure.id, label, outcome: request.outcome,
        clips: [...clips], visible, posture: after.posture, room: world.observe(actor).insideRoom,
        travelM: Math.hypot(after.x - before.x, after.z - before.z) });
      return request.outcome?.ok;
    }
    try {
      world.attach(actor, { x: -127, z: -14 }, figure.id);
      if (await run("enter car", { type: "enter_vehicle", vehicle: "car-east" })) {
        await run("drive", { type: "drive", speed: 2, seconds: 2 });
        await run("brake", { type: "drive", brake: 1, seconds: 2 });
        await run("exit car", { type: "exit_vehicle" });
      }
      world.detach(actor);
      world.attach(actor, { x: -22.92, z: -68.5, heading: Math.PI }, figure.id);
      if (!await run("enter Tea House", { type: "enter", place: "tea" })) continue;
      if (await run("sit", { type: "sit", sittable: "tea-east-right" })) {
        await run("stand", { type: "stand" });
      }
      await run("radio", { type: "interact", target: "tea-radio" });
      await run("exit Tea House", { type: "go_to", point: [-22.92, -68.5] });
    } finally {
      world.detach(actor);
      for (let t = 0; t < 4; t += dt) world.tick(dt);
    }
  }
}
console.log(JSON.stringify(rows, null, 2));
