// agentStream.ts — speak a line while it is still being synthesized, without stuttering on slow devices.
//
// Whole-line synthesis made the first sound wait for the entire line (7.3 s for 3 s of speech in the headless test box). Streaming
// starts after the first chunks. But starting too early on a device slower than real time just stutters, so the start is adaptive:
//   fast device (audio arrives >= START_RATE x real time): start once LEAD_S of audio is buffered;
//   slow device: wait until the buffer covers the remaining synthesis, buffered >= estTotal * (1 - rate), then start.
// Pure over injected deps (chunk source, sink, clock) so vitest covers it headless.
export const LEAD_S = 0.4;
export const START_RATE = 1.15;
/** Speech runs about this many characters per second; used only to estimate a slow stream's total length. */
export const CHARS_PER_S = 14;

export interface ChunkStream { chunks: AsyncIterable<Float32Array>; cancel(): void; sampleRate: number }
export interface Sink { push(pcm: Float32Array, sampleRate: number): void; end(): void; cancel(): void; readonly seconds: number }

export interface StreamDeps {
  open(): ChunkStream | null;
  beginSink(): Sink | null;
  now(): number;
}

export interface StreamResult {
  /** "live" when audio was scheduled, "silent" when nothing could be made. */
  shape: "live" | "silent";
  seconds: number;
  /** ms from open() to the first chunk arriving. */
  firstChunkMs: number | null;
  /** ms from open() to the first scheduled sound (includes the adaptive buffering). */
  startMs: number | null;
  /** audio seconds per wall second at the moment playback started (null if unknown). */
  rate: number | null;
  /** True when the adaptive policy held playback back because the device is slower than real time. */
  buffered: boolean;
}

/** Returns null when streaming is unavailable (engine not loaded, or the sink cannot play): the caller falls back. */
export async function streamSpeech(deps: StreamDeps, text: string): Promise<StreamResult | null> {
  const stream = deps.open();
  if (!stream) return null;
  const sink = deps.beginSink();
  if (!sink) { stream.cancel(); return null; }
  const t0 = deps.now();
  const est = Math.max(LEAD_S, text.length / CHARS_PER_S);
  const held: Float32Array[] = [];
  let heldSec = 0;
  let firstChunkAt: number | null = null;
  let started: { at: number; rate: number | null } | null = null;
  let buffered = false;
  const secOf = (c: Float32Array) => c.length / stream.sampleRate;
  const startNow = (rate: number | null) => {
    started = { at: deps.now(), rate };
    for (const c of held) sink.push(c, stream.sampleRate);
    held.length = 0;
  };
  try {
    for await (const chunk of stream.chunks) {
      const t = deps.now();
      if (firstChunkAt === null) firstChunkAt = t;
      if (started) { sink.push(chunk, stream.sampleRate); continue; }
      held.push(chunk);
      heldSec += secOf(chunk);
      if (heldSec < LEAD_S) continue;
      // Rate over the chunks seen so far; the first chunk's own latency is not part of the steady-state pace.
      const spanS = (t - firstChunkAt) / 1000;
      const rate = spanS > 0 ? (heldSec - secOf(held[0])) / spanS : null;
      if (rate === null || rate >= START_RATE) { startNow(rate); continue; }
      buffered = true;
      if (heldSec >= est * (1 - Math.max(0, Math.min(1, rate)))) startNow(rate);
    }
    // Stream finished before the policy started playback (short line, or a slow device holding it): play it now.
    if (!started && held.length > 0) startNow(null);
    sink.end();
  } catch (e) {
    sink.cancel();
    stream.cancel();
    if (sink.seconds === 0) throw e;
    return { shape: "live", seconds: sink.seconds, firstChunkMs: firstChunkAt === null ? null : firstChunkAt - t0, startMs: started ? (started as { at: number }).at - t0 : null, rate: null, buffered };
  }
  const s = started as { at: number; rate: number | null } | null;
  return {
    shape: sink.seconds > 0 ? "live" : "silent",
    seconds: sink.seconds,
    firstChunkMs: firstChunkAt === null ? null : firstChunkAt - t0,
    startMs: s ? s.at - t0 : null,
    rate: s ? s.rate : null,
    buffered,
  };
}
