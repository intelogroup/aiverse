// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  ready: false,
  cache: new Map<string, { pcm: Float32Array; sampleRate: number }>(),
  synthCalls: 0,
}));
vi.mock("./phononTts", () => ({
  VOICE_MAGE: "Master Aldric",
  VOICE_SUMMER: "Zoey",
  phononReady: () => engine.ready,
  cachedLine: (text: string, voice: string) => engine.cache.get(`${voice}|${text}`) ?? null,
  synthLine: async () => {
    engine.synthCalls++;
    return { pcm: new Float32Array(2400), sampleRate: 24000, synthMs: 5, audioMs: 100 };
  },
}));

import { GREETING_SCRIPT, PlazaGreeting, makeLiveSpeech, type PreparedLine } from "./plazaTts";
import type { SoundDirector } from "./soundDirector";

const fakeBuffer = { duration: 1.5 } as unknown as AudioBuffer;
const director = {
  consent: "granted",
  decodeAudio: async () => fakeBuffer,
  playVoicePcm: () => 1,
  playVoiceBuffer: () => 1.5,
} as unknown as SoundDirector;

beforeEach(() => {
  engine.ready = false;
  engine.cache.clear();
  engine.synthCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
});

describe("makeLiveSpeech never waits on the engine", () => {
  it("engine still warming: the pre-rendered clip, at once, and no synth is attempted", async () => {
    const line = await makeLiveSpeech(director).prepare(GREETING_SCRIPT[0]);
    expect(line.shape).toBe("clip");
    expect(engine.synthCalls).toBe(0);
  });
  it("a line synthesized ahead of time plays live without a synth call", async () => {
    const m = GREETING_SCRIPT[0];
    engine.cache.set(`${m.voiceId}|${m.text}`, { pcm: new Float32Array(10), sampleRate: 24000 });
    const line = await makeLiveSpeech(director).prepare(m);
    expect(line.shape).toBe("live");
    expect(engine.synthCalls).toBe(0);
  });
  it("engine loaded, line not cached: synthesized live", async () => {
    engine.ready = true;
    const line = await makeLiveSpeech(director).prepare(GREETING_SCRIPT[1]);
    expect(line.shape).toBe("live");
    expect(engine.synthCalls).toBe(1);
  });
});

describe("PlazaGreeting: the gesture follows the voice", () => {
  it("each speaker talks only while their line plays; a silent line gets no gesture", async () => {
    const events: string[] = [];
    const lines: PreparedLine[] = [
      { shape: "clip", buffer: fakeBuffer },
      { shape: "silent", error: "x" },
      { shape: "clip", buffer: fakeBuffer },
      { shape: "clip", buffer: fakeBuffer },
    ];
    let i = 0;
    const g = new PlazaGreeting({
      director,
      setSummerTalking: (on) => events.push(`summer:${on}`),
      setMageTalking: (on) => events.push(`mage:${on}`),
      prepare: async () => lines[i++],
      play: (line) => {
        events.push("play");
        return line.shape === "silent" ? 0 : 1.5;
      },
      sleep: async () => {},
    });
    await g.start(() => ({ x: -17, z: 13.5 }));
    // mage line 1 plays -> talk on/off; summer line 2 is silent -> no summer:true; mage line 3; summer line 4
    expect(events.slice(0, 3)).toEqual(["play", "mage:true", "mage:false"]);
    const summerLine2 = events.slice(3, 5);
    expect(summerLine2).toEqual(["play", "summer:false"]); // silent: never switched on
    expect(events).toContain("summer:true"); // line 4 did play
    expect(events.filter((e) => e === "mage:true")).toHaveLength(2);
    // and everybody stops at the end
    expect(events.slice(-2).sort()).toEqual(["mage:false", "summer:false"]);
  });
});
