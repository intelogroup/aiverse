/** Run against a local console with `bun tools/embodied/social-trial.ts`.
 * Uses playwright-core (override its module path with EMBODIED_PLAYWRIGHT_MODULE).
 * Each policy sees only its own body API. The harness controls initial facing.
 */
import type { ScoutApi } from "../../apps/console/src/features/world/ScoutAgent";

const base = new URL(process.env.EMBODIED_BASE ?? "http://127.0.0.1:5184");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("requires a local console");
base.search = "?world=city3&agent=pair";
const { chromium } = await import(process.env.EMBODIED_PLAYWRIGHT_MODULE ?? "playwright-core");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  for (const facing of ["toward", "away"] as const) {
    await page.goto(base.toString());
    await page.waitForFunction(() => {
      const w = window as unknown as { __scout?: ScoutApi; __scoutPeer?: ScoutApi };
      return w.__scout?.ready() && w.__scoutPeer?.ready();
    }, undefined, { timeout: 45000 });
    const result = await page.evaluate(async (facing: "toward" | "away") => {
      const w = window as unknown as { __scout: ScoutApi; __scoutPeer: ScoutApi };
      const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
      if (facing === "away") await w.__scoutPeer.act({ type: "face", headingDeg: 0 });
      const deadline = performance.now() + 4500;
      const respond = async (api: ScoutApi) => {
        while (performance.now() < deadline) {
          const snapshot = api.snapshot();
          const seen = snapshot?.movers.find(actor => actor.id === "scout" && actor.gesture === "Waving");
          if (seen) {
            const action = { type: "play", clip: "NodYes" } as const;
            const pending = api.act(action);
            let clip: string | null | undefined;
            const renderDeadline = performance.now() + 1500;
            while (performance.now() < renderDeadline) {
              clip = api.snapshot()?.renderedClip;
              if (clip === action.clip) break;
              await pause(50);
            }
            return { seen: seen.gesture, chosen: action.clip, clip, outcome: (await pending)?.status };
          }
          await pause(80);
        }
        const outcome = await api.act({ type: "wait", seconds: 0.5 });
        return { seen: null, chosen: "wait", clip: outcome?.snapshot?.clip, outcome: outcome?.status };
      };
      const greet = async (api: ScoutApi) => {
        const seen = api.snapshot()?.movers.find(actor => actor.id === "scout-peer");
        if (!seen) return { seen: null, chosen: "wait", outcome: (await api.act({ type: "wait", seconds: 0.5 }))?.status };
        const pending = api.act({ type: "play", clip: "Waving" });
        let clip: string | null | undefined;
        const renderDeadline = performance.now() + 1000;
        while (performance.now() < renderDeadline) {
          clip = api.snapshot()?.renderedClip;
          if (clip === "Waving") break;
          await pause(30);
        }
        return { seen: seen.id, chosen: "Waving", clip, outcome: (await pending)?.status };
      };
      const [receiver, sender] = await Promise.all([respond(w.__scoutPeer), greet(w.__scout)]);
      return { facing, sender, receiver };
    }, facing);
    console.log(JSON.stringify(result));
    if (result.sender.chosen !== "Waving" || !("clip" in result.sender) || result.sender.clip !== "Waving" || result.sender.outcome !== "done" ||
      result.receiver.outcome !== "done" ||
      (facing === "toward" && (result.receiver.chosen !== "NodYes" || result.receiver.clip !== "NodYes")) ||
      (facing === "away" && result.receiver.chosen !== "wait")) {
      throw new Error(`social trial failed for ${facing}`);
    }
  }
} finally {
  await browser.close();
}
