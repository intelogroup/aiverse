/**
 * plazaTts.ts — the plaza greeting probe (Jim, 2026-11-07): two
 * verse characters hold a spoken conversation on the Bazaar plaza.
 *
 * The split Jim chose: bots talk to each other over A2A (data,
 * silent) — the messages below are all that ever crosses between
 * them. Speech is the human surface only: THIS client synthesizes
 * each line locally (phononTts.ts) and plays it through the sound
 * director's positional voice emitter at the speaker's position,
 * so a listener standing near hears the conversation, and hears
 * it fade as they walk away. No audio crosses any wire.
 *
 * The performers: the Mage (the stall-0 keeper, keeper.ts) and
 * Summer — who IS the walk bot in City 3. The greeting starts when
 * Summer walks into the keeper's own greeting radius (the same
 * 2.2 m that turns him to face her and starts his Talking loop),
 * once per session, and only after the user has granted sound
 * consent (the director refuses earlier at every layer anyway).
 * While Summer's lines play, her Talking clip is fired on the walk
 * override — the same clip channel the HUD's test buttons use.
 *
 * Speech shape: live in-tab Phonon synthesis, with an automatic
 * fallback — if the engine cannot load or a line fails to
 * synthesize, the line plays from its pre-rendered clip (rendered
 * locally with the same engine + voices for the ear-test) through
 * the same emitter. The log records which shape spoke each line.
 */

import { KEEPER_ENTER_RADIUS, KEEPER_POS } from "./keeper";
import { synthLine, VOICE_MAGE, VOICE_SUMMER } from "./phononTts";
import type { SoundDirector } from "./soundDirector";

export type PlazaBotId = "mage" | "summer";

/** One A2A message: everything the two bots exchange. Data only. */
export interface A2aMessage {
  seq: number;
  from: PlazaBotId;
  to: PlazaBotId;
  text: string;
  /** The speaker's designed catalog voice (phononTts.ts). */
  voiceId: string;
  /** The pre-rendered fallback clip's key (assets/tts/lines/<clip>.mp3). */
  clip: string;
}

/** The ear-test script, verbatim (Jim heard these takes, 2026-11-07). */
export const GREETING_SCRIPT: readonly A2aMessage[] = [
  {
    seq: 0,
    from: "mage",
    to: "summer",
    voiceId: VOICE_MAGE,
    clip: "mage1",
    text: "Good morning. Welcome to the Sunstone Bazaar.",
  },
  {
    seq: 1,
    from: "summer",
    to: "mage",
    voiceId: VOICE_SUMMER,
    clip: "summer1",
    text: "Good morning. This is my first time on the plaza. What should I see first?",
  },
  {
    seq: 2,
    from: "mage",
    to: "summer",
    voiceId: VOICE_MAGE,
    clip: "mage2",
    text: "Start here at the fountain, then wander the stalls, and do not miss the tea house on the south side.",
  },
  {
    seq: 3,
    from: "summer",
    to: "mage",
    voiceId: VOICE_SUMMER,
    clip: "summer2",
    text: "The tea house it is. Thank you.",
  },
];

/** How a line was actually spoken: live synthesis, the fallback
 * clip, or not at all (silent — no consent/context; a skipped beat). */
export type LineShape = "live" | "clip" | "silent";

export type PreparedLine =
  | { shape: "live"; pcm: Float32Array; sampleRate: number }
  | { shape: "clip"; buffer: AudioBuffer }
  | { shape: "silent"; error?: string };

export interface GreetingLogEntry extends A2aMessage {
  shape: LineShape;
  /** Seconds of audio the emitter took (0 when silent). */
  seconds: number;
  /** ms from the exchange's start to this line's playback start. */
  atMs: number;
}

/** Pause between lines — a conversational beat (ms). */
export const LINE_GAP_MS = 350;

export interface PlazaDeps {
  director: SoundDirector;
  /** Fire/clear Summer's Talking clip on the walk override. */
  setSummerTalking: (on: boolean) => void;
  /** Synthesize (or fetch the fallback clip for) one line. */
  prepare: (msg: A2aMessage) => Promise<PreparedLine>;
  /** Play a prepared line positionally; returns its seconds. */
  play: (line: PreparedLine, pos: { x: number; z: number }, speaker: PlazaBotId) => number;
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The production speech path: live Phonon synthesis first; any
 * failure (engine load, WASM, a single line) falls back to the
 * pre-rendered clip for that line, decoded on the director's own
 * context. Nothing here throws — a line that cannot be made is a
 * silent beat, with the reason kept on the result.
 */
export function makeLiveSpeech(
  director: SoundDirector,
): Pick<PlazaDeps, "prepare" | "play"> {
  return {
    async prepare(msg: A2aMessage): Promise<PreparedLine> {
      try {
        const r = await synthLine(msg.text, msg.voiceId);
        return { shape: "live", pcm: r.pcm, sampleRate: r.sampleRate };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        try {
          const res = await fetch(`/assets/tts/lines/${msg.clip}.mp3`);
          if (!res.ok) return { shape: "silent", error: `${reason}; clip HTTP ${res.status}` };
          const buf = await director.decodeAudio(await res.arrayBuffer());
          return buf
            ? { shape: "clip", buffer: buf }
            : { shape: "silent", error: `${reason}; clip undecodable` };
        } catch (e2) {
          return {
            shape: "silent",
            error: `${reason}; clip: ${e2 instanceof Error ? e2.message : String(e2)}`,
          };
        }
      }
    },
    play(line, pos, speaker) {
      if (line.shape === "live")
        return director.playVoicePcm(line.pcm, line.sampleRate, pos, speaker);
      if (line.shape === "clip")
        return director.playVoiceBuffer(line.buffer, pos, speaker);
      return 0;
    },
  };
}

/**
 * The exchange runner. Pure sequencing over injected deps (the
 * keeper trigger + consent gates live here; synthesis/playback are
 * the deps), so vitest covers the conversation headless.
 */
export class PlazaGreeting {
  readonly log: GreetingLogEntry[] = [];
  status: "idle" | "running" | "done" = "idle";
  private played = false;
  private deps: PlazaDeps;

  constructor(deps: PlazaDeps) {
    this.deps = deps;
  }

  /** The greeting fires at most once per session. */
  get playedOnce(): boolean {
    return this.played;
  }

  /**
   * The walk-mode trigger, fed the bot's position at ~10 Hz: the
   * bot standing in the keeper's greeting radius starts the
   * exchange — but never before sound consent (nothing may even
   * attempt to reach the user's device unasked).
   */
  maybeTrigger(botPos: { x: number; z: number } | null): void {
    if (this.played || this.status === "running") return;
    if (this.deps.director.consent !== "granted") return;
    if (!botPos || !Number.isFinite(botPos.x) || !Number.isFinite(botPos.z)) return;
    const d = Math.hypot(botPos.x - KEEPER_POS[0], botPos.z - KEEPER_POS[1]);
    if (d <= KEEPER_ENTER_RADIUS) void this.start(() => botPos);
  }

  /**
   * Run the exchange. `getBotPos` is sampled at each of Summer's
   * lines (she speaks from where she stands). Refuses to start
   * without consent, and to run twice.
   */
  async start(
    getBotPos: () => { x: number; z: number } | null,
  ): Promise<void> {
    if (this.status === "running" || this.played) return;
    if (this.deps.director.consent !== "granted") return;
    this.played = true;
    this.status = "running";
    const t0 = performance.now();
    let next: Promise<PreparedLine> | null = null;
    try {
      for (let i = 0; i < GREETING_SCRIPT.length; i++) {
        const msg = GREETING_SCRIPT[i];
        const prepared = next ?? this.deps.prepare(msg);
        // Pipeline: the next line synthesizes while this one plays.
        next =
          i + 1 < GREETING_SCRIPT.length
            ? this.deps.prepare(GREETING_SCRIPT[i + 1])
            : null;
        const line = await prepared.catch(
          (): PreparedLine => ({ shape: "silent" }),
        );
        const pos =
          msg.from === "mage"
            ? { x: KEEPER_POS[0], z: KEEPER_POS[1] }
            : (getBotPos() ?? { x: KEEPER_POS[0], z: KEEPER_POS[1] - 2 });
        if (msg.from === "summer") this.deps.setSummerTalking(true);
        const seconds = this.deps.play(line, pos, msg.from);
        this.log.push({
          ...msg,
          shape: line.shape,
          seconds,
          atMs: performance.now() - t0,
        });
        await this.deps.sleep(Math.max(0, seconds * 1000) + LINE_GAP_MS);
        if (msg.from === "summer") this.deps.setSummerTalking(false);
      }
    } finally {
      this.deps.setSummerTalking(false);
      this.status = "done";
    }
  }
}

/** The greeting wired for the real console (live speech path). */
export function createPlazaGreeting(
  director: SoundDirector,
  setSummerTalking: (on: boolean) => void,
): PlazaGreeting {
  return new PlazaGreeting({
    director,
    setSummerTalking,
    ...makeLiveSpeech(director),
    sleep: realSleep,
  });
}
