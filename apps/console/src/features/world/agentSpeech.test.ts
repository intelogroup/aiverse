import { describe, expect, it } from "vitest";
import { AGENT_VOICE_POOL } from "./phononTts";
import type { PreparedLine } from "./plazaTts";
import { EMITTER_AUDIBLE_M } from "./soundLogic";
import { MAX_NARRATION_CHARS, NARRATION_GAP_S, NARRATION_STALE_S, spokenNarration } from "./agentSpeech";
import { AgentSpeech, AUDIBLE_M, MAX_QUEUE, MAX_SPOKEN_CHARS, SPEAKER_GAP_S, STALE_S, VoiceAssigner, hashName, spokenText, type AgentSpeechDeps } from "./agentSpeech";

function rig(over: Partial<AgentSpeechDeps> = {}) {
  let t = 0;
  const played: { pos: { x: number; z: number }; speaker: string; line: PreparedLine }[] = [];
  const prepared: { text: string; voice: string }[] = [];
  const bodies = new Map<number, { x: number; z: number }>([[1, { x: 2, z: 0 }], [2, { x: 5, z: 0 }]]);
  const deps: AgentSpeechDeps = {
    consent: () => true,
    listener: () => ({ x: 0, z: 0 }),
    speakerPos: (n) => bodies.get(n) ?? null,
    prepare: async (text, voice) => { prepared.push({ text, voice }); return { shape: "live", pcm: new Float32Array(10), sampleRate: 24000 }; },
    play: (line, pos, speaker) => { played.push({ line, pos, speaker }); return 1; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    ...over,
  };
  const speech = new AgentSpeech(deps);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  return { speech, played, prepared, bodies, settle, advance: (ms: number) => { t += ms; } };
}

describe("voice assignment", () => {
  it("is stable for the same name and never uses the scripted characters' voices", () => {
    const a = new VoiceAssigner();
    expect(a.voiceFor("Wren-1")).toBe(a.voiceFor("Wren-1"));
    for (const r of AGENT_VOICE_POOL) expect(["Zoey", "Master Aldric", "Hugh"]).not.toContain(r.voice);
  });
  it("gives distinct voices to present speakers until the pool is exhausted", () => {
    const a = new VoiceAssigner();
    const got = Array.from({ length: AGENT_VOICE_POOL.length }, (_, i) => a.voiceFor(`agent-${i}`));
    expect(new Set(got).size).toBe(AGENT_VOICE_POOL.length);
    expect(AGENT_VOICE_POOL.every((v) => got.includes(v.voice))).toBe(true);
  });
  it("hashName is deterministic", () => { expect(hashName("Wren")).toBe(hashName("Wren")); expect(hashName("a")).not.toBe(hashName("b")); });
});

describe("spokenText", () => {
  it("strips markdown and URLs, collapses whitespace, caps length", () => {
    expect(spokenText("**Hello**   see https://x.test/a?b=1 `ok`")).toBe("Hello see ok");
    expect(spokenText("x".repeat(500)).length).toBe(MAX_SPOKEN_CHARS);
    expect(spokenText("   ")).toBe("");
  });
});

describe("AgentSpeech", () => {
  it("speaks a nearby line at the speaker's position with a stable voice", async () => {
    const r = rig();
    r.speech.hear({ n: 1, name: "Wren", text: "Hello there" });
    await r.settle();
    expect(r.played).toHaveLength(1);
    expect(r.played[0].pos).toEqual({ x: 2, z: 0 });
    expect(r.prepared[0].voice).toBe(r.speech.voices.voiceFor("Wren"));
    expect(r.speech.log[0]).toMatchObject({ queuedMs: 0, prepareMs: 0, shape: "live", playAt: 0 });
  });
  it("synthesizes nothing before sound consent", async () => {
    const r = rig({ consent: () => false });
    r.speech.hear({ n: 1, name: "Wren", text: "Hi" });
    await r.settle();
    expect(r.prepared).toHaveLength(0);
    expect(r.speech.drops[0].reason).toBe("no_consent");
  });
  it("drops far speakers, missing listeners, departed speakers and empty text", async () => {
    const r = rig();
    r.bodies.set(3, { x: AUDIBLE_M + 1, z: 0 });
    r.speech.hear({ n: 3, name: "Far", text: "hi" });
    r.speech.hear({ n: 99, name: "Gone", text: "hi" });
    r.speech.hear({ n: 1, name: "W", text: "  **  " });
    expect(r.speech.drops.map((d) => d.reason)).toEqual(["far", "speaker_gone", "empty"]);
    const r2 = rig({ listener: () => null });
    r2.speech.hear({ n: 1, name: "W", text: "hi" });
    expect(r2.speech.drops[0].reason).toBe("no_listener");
  });
  it("rate-limits a chatty speaker but lets another speaker through", async () => {
    const r = rig();
    r.speech.hear({ n: 1, name: "A", text: "one" });
    r.speech.hear({ n: 1, name: "A", text: "two" });
    r.speech.hear({ n: 2, name: "B", text: "three" });
    await r.settle();
    expect(r.speech.drops.map((d) => d.reason)).toEqual(["gap"]);
    expect(r.played).toHaveLength(2);
    r.advance(SPEAKER_GAP_S * 1000 + 1);
    r.speech.hear({ n: 1, name: "A", text: "four" });
    await r.settle();
    expect(r.played).toHaveLength(3);
  });
  it("serializes: only one line is being prepared at a time, in order", async () => {
    let inflight = 0, maxInflight = 0;
    const r = rig({ prepare: async () => { inflight++; maxInflight = Math.max(maxInflight, inflight); await Promise.resolve(); inflight--; return { shape: "silent" } as PreparedLine; } });
    r.bodies.set(3, { x: 1, z: 1 });
    r.speech.hear({ n: 1, name: "A", text: "a" }); r.speech.hear({ n: 2, name: "B", text: "b" }); r.speech.hear({ n: 3, name: "C", text: "c" });
    await r.settle();
    expect(maxInflight).toBe(1);
    expect(r.speech.log.map((l) => l.name)).toEqual(["A", "B", "C"]);
  });
  it("caps the queue", async () => {
    const r = rig({ prepare: () => new Promise(() => {}) }); // first line never finishes, so the rest queue up
    for (let i = 0; i < MAX_QUEUE + 3; i++) { r.bodies.set(10 + i, { x: 1, z: 1 }); r.speech.hear({ n: 10 + i, name: `S${i}`, text: "x" }); }
    await r.settle();
    expect(r.speech.drops.filter((d) => d.reason === "queue_full").length).toBeGreaterThan(0);
  });
  it("drops a line that waited past STALE_S and a prepare failure becomes a silent beat, not a throw", async () => {
    let calls = 0;
    const r = rig({ prepare: async () => { calls++; if (calls === 1) throw new Error("engine down"); return { shape: "live", pcm: new Float32Array(1), sampleRate: 24000 }; } });
    r.speech.hear({ n: 1, name: "A", text: "first" });
    await r.settle();
    expect(r.speech.log[0].shape).toBe("silent");
    r.advance(1);
    const r3 = rig({ play: () => { r3.advance((STALE_S + 1) * 1000); return 1; } });
    r3.speech.hear({ n: 1, name: "A", text: "a" }); r3.speech.hear({ n: 2, name: "B", text: "b" });
    await r3.settle();
    expect(r3.speech.drops.some((d) => d.reason === "stale")).toBe(true);
  });
  it("uses the streaming path when available and waits for the audio that is still playing", async () => {
    let t = 0;
    const slept: number[] = [];
    const r = rig({
      now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms; },
      speak: async () => { t += 500; return { shape: "live", seconds: 3, firstChunkMs: 120, startMs: 200, rate: 2.5, buffered: false }; },
      prepare: async () => { throw new Error("must not be used when streaming works"); },
    } as never);
    r.speech.hear({ n: 1, name: "A", text: "hello there" });
    await r.settle();
    expect(r.speech.log[0].stream).toEqual({ firstChunkMs: 120, startMs: 200, rate: 2.5, buffered: false });
    expect(r.speech.log[0].playAt).toBe(200); // started at 0, first sound 200 ms later
    expect(r.speech.log[0].seconds).toBe(3);
    // synthesis ended at 500 ms; audio ends 200 + 3000 after start: ~2700 ms still to wait, plus the gap
    expect(slept[0]).toBeGreaterThan(2500);
    expect(slept[0]).toBeLessThan(3300);
  });
  it("falls back to prepare + play when streaming is unavailable", async () => {
    const r = rig({ speak: async () => null } as never);
    r.speech.hear({ n: 1, name: "A", text: "hello" });
    await r.settle();
    expect(r.played).toHaveLength(1);
    expect(r.speech.log[0].stream).toBeUndefined();
  });
  it("does not synthesize beyond the director's own audible range", () => {
    expect(AUDIBLE_M).toBe(EMITTER_AUDIBLE_M);
  });
  it("speaks from where the speaker stands when its turn comes, not where it was", async () => {
    const r = rig();
    r.speech.hear({ n: 1, name: "A", text: "a" });
    r.bodies.set(1, { x: 7, z: 7 });
    await r.settle();
    expect(r.played[0].pos).toEqual({ x: 7, z: 7 });
  });
});

describe("owner's agent talking to itself (hearNarration)", () => {
  it("is spoken at the listener's position in the agent's own voice, however far the body is", async () => {
    const r = rig();
    r.bodies.set(1, { x: 500, z: 500 });
    r.speech.hear({ n: 1, name: "Wren", text: "Hello out loud" }); // far: dropped as speech
    r.speech.hearNarration({ agentName: "Wren", kind: "visible", text: "Heading to the tea house." });
    await r.settle();
    expect(r.speech.drops.map((d) => d.reason)).toEqual(["far"]);
    expect(r.played).toHaveLength(1);
    expect(r.played[0].pos).toEqual({ x: 0, z: 0 }); // the listener, not the body at 500,500
    expect(r.speech.log[0]).toMatchObject({ inner: true, name: "Wren", voice: r.speech.voices.voiceFor("Wren") });
  });
  it("synthesizes nothing without consent or without a listener", async () => {
    const r1 = rig({ consent: () => false });
    r1.speech.hearNarration({ agentName: "W", kind: "visible", text: "private thought" });
    expect(r1.prepared).toHaveLength(0);
    expect(r1.speech.drops[0].reason).toBe("no_consent");
    const r2 = rig({ listener: () => null });
    r2.speech.hearNarration({ agentName: "W", kind: "visible", text: "private thought" });
    expect(r2.speech.drops[0].reason).toBe("no_listener");
  });
  it("keeps a thinking agent to one line per NARRATION_GAP_S, and a stale thought is dropped", async () => {
    const r = rig();
    r.speech.hearNarration({ agentName: "W", kind: "thinking", text: "one" });
    r.speech.hearNarration({ agentName: "W", kind: "thinking", text: "two" });
    await r.settle();
    expect(r.speech.drops.map((d) => d.reason)).toEqual(["gap"]);
    r.advance(NARRATION_GAP_S * 1000 + 1);
    r.speech.hearNarration({ agentName: "W", kind: "thinking", text: "three" });
    await r.settle();
    expect(r.played).toHaveLength(2);
    const r3 = rig({ play: () => { r3.advance((NARRATION_STALE_S + 1) * 1000); return 1; } });
    r3.bodies.set(5, { x: 1, z: 1 });
    r3.speech.hear({ n: 5, name: "B", text: "speech first" });
    r3.speech.hearNarration({ agentName: "W", kind: "visible", text: "waits behind" });
    await r3.settle();
    expect(r3.speech.drops.some((d) => d.reason === "stale")).toBe(true);
  });
  it("spokenNarration cuts a long thinking block at a sentence end, not mid-word", () => {
    const long = "The tea house is north of here. " + "I should walk along the street and check the signs carefully before turning. ".repeat(6);
    const out = spokenNarration(long);
    expect(out.length).toBeLessThanOrEqual(MAX_NARRATION_CHARS);
    expect(out.endsWith(".")).toBe(true);
    expect(spokenNarration("Short thought.")).toBe("Short thought.");
    expect(spokenNarration("x".repeat(400)).length).toBeLessThanOrEqual(MAX_NARRATION_CHARS);
  });
});
