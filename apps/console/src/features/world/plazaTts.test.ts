// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KEEPER_POS } from "./keeper";
import {
  GREETING_SCRIPT,
  PlazaGreeting,
  type A2aMessage,
  type PlazaDeps,
  type PreparedLine,
} from "./plazaTts";
import type { SoundDirector } from "./soundDirector";

function fakeDeps(consent: "unknown" | "granted" | "declined" = "granted") {
  const events: string[] = [];
  const prepared: number[] = [];
  const deps: PlazaDeps = {
    director: { consent } as unknown as SoundDirector,
    setSummerTalking: (on) => events.push(on ? "talk:on" : "talk:off"),
    prepare: (msg: A2aMessage): Promise<PreparedLine> => {
      prepared.push(msg.seq);
      return Promise.resolve({ shape: "live", pcm: new Float32Array(4), sampleRate: 24000 });
    },
    play: (_line, _pos, speaker) => {
      events.push(`play:${speaker}`);
      return 0.01;
    },
    sleep: () => Promise.resolve(),
  };
  return { deps, events, prepared };
}

const AT_KEEPER = { x: KEEPER_POS[0], z: KEEPER_POS[1] - 1.6 };

describe("GREETING_SCRIPT (the A2A exchange)", () => {
  it("is four messages alternating mage → summer → mage → summer", () => {
    expect(GREETING_SCRIPT.map((m) => m.from)).toEqual(["mage", "summer", "mage", "summer"]);
    expect(GREETING_SCRIPT.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    for (const m of GREETING_SCRIPT) expect(m.to).not.toBe(m.from);
  });
  it("carries the designed voices, never a clone", () => {
    expect(GREETING_SCRIPT[0].voiceId).toBe("Master Aldric");
    expect(GREETING_SCRIPT[1].voiceId).toBe("Zoey");
  });
});

describe("PlazaGreeting sequencing", () => {
  it("speaks the whole script in order and logs every line", async () => {
    const { deps, events } = fakeDeps();
    const g = new PlazaGreeting(deps);
    await g.start(() => AT_KEEPER);
    expect(g.status).toBe("done");
    expect(g.log.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(g.log.every((e) => e.shape === "live")).toBe(true);
    expect(events.filter((e) => e.startsWith("play:"))).toEqual([
      "play:mage",
      "play:summer",
      "play:mage",
      "play:summer",
    ]);
  });
  it("fires Summer's Talking clip only around her own lines", async () => {
    const { deps, events } = fakeDeps();
    const g = new PlazaGreeting(deps);
    await g.start(() => AT_KEEPER);
    const talkEvents = events.filter((e) => e.startsWith("talk:"));
    // on/off around line 2 (seq 1) and line 4 (seq 3), plus the
    // finally-guard's extra off — never an on without a line.
    expect(talkEvents.filter((e) => e === "talk:on")).toHaveLength(2);
    expect(events.indexOf("talk:on")).toBeGreaterThan(events.indexOf("play:mage"));
  });
  it("runs at most once", async () => {
    const { deps, prepared } = fakeDeps();
    const g = new PlazaGreeting(deps);
    await g.start(() => AT_KEEPER);
    await g.start(() => AT_KEEPER);
    expect(g.log).toHaveLength(4);
    expect(prepared.length).toBeLessThanOrEqual(5); // 4 lines + pipeline lookahead overlap
  });
});

describe("PlazaGreeting consent + trigger gates", () => {
  it("refuses to start before consent — nothing is even prepared", async () => {
    const { deps, prepared } = fakeDeps("unknown");
    const g = new PlazaGreeting(deps);
    await g.start(() => AT_KEEPER);
    expect(g.status).toBe("idle");
    expect(g.log).toHaveLength(0);
    expect(prepared).toHaveLength(0);
  });
  it("maybeTrigger fires inside the keeper radius once consent is granted", async () => {
    const { deps } = fakeDeps("granted");
    const g = new PlazaGreeting(deps);
    g.maybeTrigger(AT_KEEPER);
    // start() is async; let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(g.log.length).toBeGreaterThan(0);
    expect(g.playedOnce).toBe(true);
  });
  it("maybeTrigger stays silent outside the radius or without consent", async () => {
    const far = fakeDeps("granted");
    const gFar = new PlazaGreeting(far.deps);
    gFar.maybeTrigger({ x: KEEPER_POS[0] + 30, z: KEEPER_POS[1] });
    await new Promise((r) => setTimeout(r, 10));
    expect(gFar.log).toHaveLength(0);

    const noConsent = fakeDeps("declined");
    const gNo = new PlazaGreeting(noConsent.deps);
    gNo.maybeTrigger(AT_KEEPER);
    await new Promise((r) => setTimeout(r, 10));
    expect(gNo.log).toHaveLength(0);
  });
});
