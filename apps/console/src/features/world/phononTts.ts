/**
 * phononTts.ts — the plaza probe's speech engine: Gradium Phonon
 * 31m-en running IN the tab via the `phonon-tts` npm package (the
 * Rust runtime compiled to WASM, generation in a worker, 24 kHz
 * mono PCM out). No server, no API key, no audio leaves the device:
 * bots exchange text (A2A data) and each listener's client
 * synthesizes the speech locally — the architecture Jim picked
 * 2026-11-07 (TTS is the human surface only).
 *
 * Licensing: the engine package is MIT OR Apache-2.0; the weights
 * are the 31m-en checkpoint, Apache-2.0 — the ONLY commercial-safe
 * Phonon variant (the 40M and multilingual checkpoints are
 * CC-BY-NC and are NOT used). Voices are designed catalog voices
 * from gradium/phonon-voices (embeddings, fetched as files), never
 * clones of a real person (Jim's voice rule, 2026-11-02).
 *
 * Model hosting (changed when #37 was split): the 64.5 MB q8 GGUF is NOT
 * in git. It is fetched at first use from `PHONON_MODEL_URL`: by default
 * the pinned Hugging Face revision below (`gradium/phonon-31m-en`, sha256
 * a7d9aad2... per the original probe), or any URL set in
 * `VITE_PHONON_MODEL_URL` (a bucket/CDN you control). The tokenizer, config,
 * the two voice embeddings and the 4 fallback clips are small and stay in
 * `public/assets/tts/`. Tradeoff: a third party (HF/your CDN) must be up and
 * sees the visitor's IP on the first spoken line; the clips cover failure.
 */

const TTS_ASSETS = "/assets/tts";
/** The pinned checkpoint revision (gradium/phonon-31m-en). */
export const PHONON_MODEL_REVISION = "8c64b55ec301728e2d1695bfea87a08a267d0c2d";

/** The two designed voices of the plaza greeting (catalog names). */
export const VOICE_SUMMER = "Zoey";
export const VOICE_MAGE = "Master Aldric";
/** The Tea House bartender (catalog voice "Hugh": soft, close, sincere, middle-aged British). */
export const VOICE_BARTENDER = "Hugh";

/** Where the checkpoint is fetched from (see the header). */
export const PHONON_MODEL_URL: string =
  (import.meta.env.VITE_PHONON_MODEL_URL as string | undefined) ||
  `https://huggingface.co/gradium/phonon-31m-en/resolve/${PHONON_MODEL_REVISION}/model.q8.gguf`;

type PhononModule = typeof import("phonon-tts");
type PhononEngine = Awaited<ReturnType<PhononModule["PhononTTS"]["load"]>>;

let enginePromise: Promise<PhononEngine> | null = null;
let engineReady = false;
/** Lines synthesized ahead of time (warmPhonon): voice + text -> PCM. */
const pcmCache = new Map<string, { pcm: Float32Array; sampleRate: number }>();
const cacheKey = (text: string, voice: string) => `${voice}\u0000${text}`;
let warming: Promise<void> | null = null;

/** True once the engine has loaded: a synth call will not wait on the model download. */
export function phononReady(): boolean {
  return engineReady;
}

/** A line synthesized ahead of time, or null. */
export function cachedLine(text: string, voice: string): { pcm: Float32Array; sampleRate: number } | null {
  return pcmCache.get(cacheKey(text, voice)) ?? null;
}

/** Debug/HUD: how warm the engine is. */
export function phononWarmth(): { ready: boolean; cached: number; warming: boolean } {
  return { ready: engineReady, cached: pcmCache.size, warming: warming !== null && !engineReady };
}

/**
 * Warm the engine and pre-synthesize lines that are known in advance (the scripted greeting), so speech never waits on the
 * 64.5 MB model download or on synthesis at the moment someone walks up. Called when City 3 is entered; idempotent, and it
 * keeps the engine loaded for the rest of the page's life. No audio is played here: no sound consent is needed for it.
 */
export function warmPhonon(lines: readonly { text: string; voice: string }[]): Promise<void> {
  warming ??= (async () => {
    await loadPhonon();
    for (const l of lines) {
      if (pcmCache.has(cacheKey(l.text, l.voice))) continue;
      const r = await synthLine(l.text, l.voice);
      pcmCache.set(cacheKey(l.text, l.voice), { pcm: r.pcm, sampleRate: r.sampleRate });
    }
  })().catch((e: unknown) => {
    warming = null; // a later call may retry (e.g. the network came back)
    throw e;
  });
  return warming;
}

/**
 * Load the engine (worker + WASM + checkpoint + both voices), once. warmPhonon() calls it when City 3 is entered, so the
 * ~65 MB checkpoint is already there when the first line is needed.
 */
export function loadPhonon(): Promise<PhononEngine> {
  enginePromise ??= (async () => {
    const { PhononTTS } = await import("phonon-tts");
    const engine = await PhononTTS.load({
      lang: "en",
      model: {
        weights: { q8: PHONON_MODEL_URL },
        tokenizer: `${TTS_ASSETS}/tokenizer.json`,
        config: `${TTS_ASSETS}/config.json`,
        voices: {
          [VOICE_SUMMER]: `${TTS_ASSETS}/voices/zoey.safetensors`,
          [VOICE_MAGE]: `${TTS_ASSETS}/voices/aldric.safetensors`,
          [VOICE_BARTENDER]: `${TTS_ASSETS}/voices/hugh.safetensors`,
        },
        defaultVoice: VOICE_SUMMER,
      },
      voices: [VOICE_SUMMER, VOICE_MAGE, VOICE_BARTENDER],
    });
    engineReady = true;
    return engine;
  })().catch((e: unknown) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
}

export interface SynthResult {
  pcm: Float32Array;
  sampleRate: number;
  /** Wall time the synth call took (ms). */
  synthMs: number;
  /** The spoken line's duration (ms). */
  audioMs: number;
}

/** Synthesize one line with one voice (deterministic: the
 * package's default seed makes text+voice reproducible). */
export async function synthLine(text: string, voice: string): Promise<SynthResult> {
  const tts = await loadPhonon();
  const t0 = performance.now();
  const pcm = await tts.synth(text, { voice });
  const synthMs = performance.now() - t0;
  return {
    pcm,
    sampleRate: tts.sampleRate,
    synthMs,
    audioMs: (pcm.length / tts.sampleRate) * 1000,
  };
}

export interface PhononBenchLine {
  text: string;
  voice: string;
  /** Time from stream start to the first audio chunk (ms). */
  firstAudioMs: number | null;
  synthMs: number;
  audioMs: number;
  /** synthMs / audioMs — below 1.0 means faster than real time. */
  rtf: number;
}

export interface PhononBench {
  /** Engine load: model fetch + worker + WASM + voices (ms). */
  loadMs: number;
  device: string;
  deviceReason: string;
  threads: number;
  threadsReason: string;
  lines: PhononBenchLine[];
}

/**
 * The bench the probe brief asks for, run inside the real console:
 * load timing, then per line a streaming time-to-first-audio and a
 * full-synth real-time factor. Exposed to proofs via ?ttsDebug=1.
 */
export async function benchPhonon(
  lines: readonly { text: string; voice: string }[],
): Promise<PhononBench> {
  const t0 = performance.now();
  const tts = await loadPhonon();
  const loadMs = performance.now() - t0;
  const out: PhononBenchLine[] = [];
  for (const line of lines) {
    let firstAudioMs: number | null = null;
    const s0 = performance.now();
    const stream = tts.stream(line.text, { voice: line.voice });
    for await (const chunk of stream) {
      if (chunk.length > 0) {
        firstAudioMs = performance.now() - s0;
        break;
      }
    }
    stream.cancel();
    await stream.done.catch(() => {});
    const r = await synthLine(line.text, line.voice);
    out.push({
      text: line.text,
      voice: line.voice,
      firstAudioMs,
      synthMs: r.synthMs,
      audioMs: r.audioMs,
      rtf: r.synthMs / r.audioMs,
    });
  }
  return {
    loadMs,
    device: tts.device,
    deviceReason: tts.deviceReason,
    threads: tts.threads,
    threadsReason: tts.threadsReason,
    lines: out,
  };
}
