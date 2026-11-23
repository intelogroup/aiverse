import { describe, expect, it } from "vitest";
import { CHARS_PER_S, START_RATE, streamSpeech, type ChunkStream, type Sink } from "./agentStream";

const SR = 24000;
const chunk = (sec = 0.08) => new Float32Array(Math.round(SR * sec));

/** A stream whose chunks arrive at `rate` x real time (each 80 ms chunk takes 0.08/rate s), on a fake clock. */
function rig(opts: { chunks: number; rate: number; firstLatencyMs?: number; failAfter?: number; text?: string }) {
  let t = 0;
  const pushed: { at: number; sec: number }[] = [];
  let ended = false, cancelled = false, sinkCancelled = false;
  const sink: Sink = {
    push: (pcm) => { pushed.push({ at: t, sec: pcm.length / SR }); },
    end: () => { ended = true; },
    cancel: () => { sinkCancelled = true; },
    get seconds() { return pushed.reduce((a, p) => a + p.sec, 0); },
  };
  const stream: ChunkStream = {
    sampleRate: SR,
    cancel: () => { cancelled = true; },
    chunks: (async function* () {
      t += opts.firstLatencyMs ?? 0;
      for (let i = 0; i < opts.chunks; i++) {
        if (opts.failAfter !== undefined && i === opts.failAfter) throw new Error("engine died");
        if (i > 0) t += (0.08 / opts.rate) * 1000;
        yield chunk();
      }
    })(),
  };
  return {
    deps: { open: () => stream, beginSink: () => sink, now: () => t },
    pushed, state: () => ({ ended, cancelled, sinkCancelled }),
    text: opts.text ?? "x".repeat(Math.round(opts.chunks * 0.08 * CHARS_PER_S)),
  };
}

describe("streamSpeech", () => {
  it("returns null (caller falls back) when the engine is not loaded or the sink cannot play", async () => {
    expect(await streamSpeech({ open: () => null, beginSink: () => null, now: () => 0 }, "hi")).toBeNull();
    let cancelled = false;
    expect(await streamSpeech({ open: () => ({ chunks: (async function* () {})(), cancel: () => { cancelled = true; }, sampleRate: SR }), beginSink: () => null, now: () => 0 }, "hi")).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("a fast device starts after LEAD_S of audio, long before the line is finished", async () => {
    const r = rig({ chunks: 40, rate: 4, firstLatencyMs: 300 }); // 3.2 s of speech at 4x real time
    const res = (await streamSpeech(r.deps, r.text))!;
    expect(res.shape).toBe("live");
    expect(res.buffered).toBe(false);
    expect(res.seconds).toBeCloseTo(3.2, 1);
    expect(res.firstChunkMs).toBe(300);
    // first sound after ~LEAD_S worth of chunks (5 x 80 ms at 4x => 0.1 s of synthesis), not after the full ~1 s of synthesis
    expect(res.startMs!).toBeLessThan(300 + 400);
    expect(res.startMs!).toBeLessThan(0.8 * (300 + (3.2 / 4) * 1000));
    expect(res.rate!).toBeGreaterThanOrEqual(START_RATE);
    expect(r.state().ended).toBe(true);
  });

  /** Underruns: chunks pushed after the playback head already reached their position (head runs at 1 s per s from startMs). */
  const underruns = (pushed: { at: number; sec: number }[], startMs: number) => {
    let before = 0, n = 0;
    for (const p of pushed) { if (p.at > startMs + before * 1000 + 1) n++; before += p.sec; }
    return n;
  };

  it("a device slower than real time buffers first, so playback does not underrun", async () => {
    const r = rig({ chunks: 40, rate: 0.5 }); // 3.2 s of speech at 0.5x: synthesis takes ~6.3 s
    const res = (await streamSpeech(r.deps, r.text))!;
    expect(res.buffered).toBe(true);
    expect(res.startMs!).toBeGreaterThan(1000); // it waited
    expect(underruns(r.pushed, res.startMs!)).toBe(0);
    // ...and it did not wait for the whole synthesis either: a naive wait-for-all would start at ~6.3 s
    expect(res.startMs!).toBeLessThan(6000);
  });

  it("a fast device streams with no underrun either", async () => {
    const r = rig({ chunks: 40, rate: 3, firstLatencyMs: 200 });
    const res = (await streamSpeech(r.deps, r.text))!;
    expect(underruns(r.pushed, res.startMs!)).toBe(0);
  });

  it("a very short line is played when the stream ends, even if it never reached LEAD_S", async () => {
    const r = rig({ chunks: 3, rate: 3 }); // 0.24 s
    const res = (await streamSpeech(r.deps, "Hi."))!;
    expect(res.shape).toBe("live");
    expect(res.seconds).toBeCloseTo(0.24, 2);
    expect(r.state().ended).toBe(true);
  });

  it("an empty stream is silent, not an error", async () => {
    const r = rig({ chunks: 0, rate: 1 });
    const res = (await streamSpeech(r.deps, "..."))!;
    expect(res.shape).toBe("silent");
    expect(res.startMs).toBeNull();
  });

  it("an engine failure before any audio throws (caller falls back); after audio it keeps what played", async () => {
    const early = rig({ chunks: 10, rate: 2, failAfter: 0 });
    await expect(streamSpeech(early.deps, "x".repeat(20))).rejects.toThrow("engine died");
    expect(early.state().sinkCancelled).toBe(true);
    const late = rig({ chunks: 20, rate: 4, failAfter: 12 });
    const res = (await streamSpeech(late.deps, "x".repeat(40)))!;
    expect(res.shape).toBe("live");
    expect(res.seconds).toBeGreaterThan(0.5);
  });
});
