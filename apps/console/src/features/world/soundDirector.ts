/**
 * Sound v1 — the audio director: the one stateful WebAudio engine
 * behind the five v1 pieces (see soundLogic.ts for the pure maths it
 * runs on and the design notes). GlbWorld owns one instance per
 * mount; a ~10 Hz driver feeds it the listener's position, the tea
 * door's angle/state and the tea room's rect, and the walk HUD reads
 * its banner + mute state.
 *
 * Permission policy (Jim, 2026-11-07 — "make sure the audio can
 * reach user device with permission asking"): verse audio reaches
 * the user's device ONLY after a deliberate, labelled consent in
 * the walk HUD. The director starts unconsented; arm() is a no-op
 * until grantConsent() runs, and grantConsent() is called from the
 * HUD button's own click handler, so AudioContext creation +
 * resume happen inside that gesture's call stack (the iOS Safari
 * requirement). A decline is remembered for the session: no sound,
 * no re-asking. Post-consent, later gestures still call arm() to
 * resume a suspended context, exactly as before.
 *
 * Asset provenance (all under public/assets/sound/, licenses in the
 * PR body): PA clips rendered locally with Gradium Phonon
 * (gradium/phonon-31m-en, Apache-2.0) in the catalog voice "Hadley";
 * door creak + latch + the four step variants from Kenney's RPG
 * Audio (CC0), converted OGG→MP3 for Safari's decoder; the tea-room
 * loop is "Heavenly Loop" by isaiah658 (OpenGameArt, CC0). The wind
 * is procedural (filtered noise) — no asset.
 *
 * Follow-on (Jim, 2026-11-07): the Mage's stall emitter — one
 * positional music voice at the keeper's stand point, its gain set
 * per tick from soundLogic.emitterGain (full inside 2.5 m, silence
 * at 16 m) and ducked by the PA with the rest of the music layer.
 * Its loop is the loop version of "Medieval: Minstrel Dance" by
 * randommind (OpenGameArt, CC0 — verified on the track's own page),
 * converted WAV→MP3 like the other clips.
 */

import { TEA_DOOR_ORIGIN, type TeaDoorState } from "./teaDoor";
import { setPlantSink } from "./soundPlants";
import {
  bannerVisible,
  clockEventsBetween,
  creakFor,
  distanceGain,
  districtAt,
  duckedGain,
  emitterGain,
  switchedEmitterGain,
  paAudible,
  stepFade,
  DOOR_AUDIBLE_M,
  MAGE_STALL_POS,
  MUSIC_GAIN,
  PA_GAIN,
  PA_LINES,
  STEP_AUDIBLE_M,
  VERSE_CLOCK_START_S,
  VOICE_GAIN,
  WIND_GAIN,
  type Announcement,
  type DistrictLite,
  type PaScope,
} from "./soundLogic";

const SOUND = "/assets/sound";
const CLIP_URLS: Record<string, string> = {
  "pa-dawn": `${SOUND}/pa-dawn.mp3`,
  "pa-dusk": `${SOUND}/pa-dusk.mp3`,
  "pa-tea": `${SOUND}/pa-tea.mp3`,
  "door-creak": `${SOUND}/door-creak.mp3`,
  "door-latch": `${SOUND}/door-latch.mp3`,
  "step-1": `${SOUND}/step-1.mp3`,
  "step-2": `${SOUND}/step-2.mp3`,
  "step-3": `${SOUND}/step-3.mp3`,
  "step-4": `${SOUND}/step-4.mp3`,
  "tea-music": `${SOUND}/tea-music.mp3`,
  "stall-music": `${SOUND}/stall-music.mp3`,
};
const STEP_KEYS = ["step-1", "step-2", "step-3", "step-4"] as const;

/** What the driver hands the director each tick. */
export interface SoundFrame {
  /** Real seconds since the previous tick. */
  dt: number;
  /** The walk bot's position, or null before its first frame. */
  listener: { x: number; z: number } | null;
  /** Tea door machine state + active leaf angle (degrees). */
  doorAngle: number;
  doorState: TeaDoorState;
  /** Tea room footprint [minX, minZ, maxX, maxZ], once rooms load. */
  teaRect: readonly [number, number, number, number] | null;
  /** Switchable positional emitters (the Tea House radio): where they stand and whether they are on. */
  emitters?: readonly SoundEmitter[];
}

/** A switchable positional emitter: loops the radio clip at (x, z) while `on`, loudness by distance (emitterGain). */
export interface SoundEmitter {
  id: string;
  x: number;
  z: number;
  on: boolean;
}

/** The clip a radio plays (test audio: the Mage's stall music; swap for real radio content later). */
export const RADIO_CLIP = "stall-music";

interface EmitterNode {
  gain: GainNode;
  analyser: AnalyserNode;
  src: AudioBufferSourceNode | null;
  level: number;
  rms: number;
  on: boolean;
}

/** The user's sound permission for this session (see header). */
export type SoundConsent = "unknown" | "granted" | "declined";

export interface SoundSnapshot {
  armed: boolean;
  ctxState: string;
  consent: SoundConsent;
  muted: boolean;
  /** The positional voice emitter (bot speech): who is speaking,
   * the positional gain on their voice right now, and its level. */
  voice: { playing: boolean; speaker: string | null; gain: number; level: number };
  district: string | null;
  insideTea: boolean;
  banner: string | null;
  paPlaying: boolean;
  paLevel: number;
  masterLevel: number;
  /** The stall emitter's analyser RMS (its own voice, pre-bus). */
  stallLevel: number;
  /** Switchable emitters (radios): on flag, the gain applied to the node now, analyser RMS. */
  emitters: Record<string, { on: boolean; gain: number; level: number }>;
  gains: { pa: number; music: number; wind: number; creak: number; stall: number; master: number };
  steps: number;
  lastStep: { d: number; gain: number } | null;
  latchCount: number;
  /** Verse-clock seconds (starts at VERSE_CLOCK_START_S). */
  clockS: number;
  announcements: number;
}

export class SoundDirector {
  muted = false;

  private consentState: SoundConsent = "unknown";
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private paBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private windBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private paAnalyser: AnalyserNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private voiceGainNode: GainNode | null = null;
  private voiceAnalyser: AnalyserNode | null = null;
  /** The utterance on the voice emitter right now, if any. */
  private voiceUtter: {
    pos: { x: number; z: number };
    speaker: string;
    endsAt: number;
  } | null = null;
  private voiceGain = 0;
  private voiceLevel = 0;
  private buffers = new Map<string, AudioBuffer>();
  private creakGain: GainNode | null = null;
  private creakSrc: AudioBufferSourceNode | null = null;
  private musicStarted = false;
  private stallGainNode: GainNode | null = null;
  private stallAnalyser: AnalyserNode | null = null;
  private stallStarted = false;
  private readonly emitterNodes = new Map<string, EmitterNode>();
  private stallLevel = 0;
  private stallRms = 0;

  private defs: DistrictLite[] = [];
  private elapsed = 0; // director seconds since arm()
  private announcement: Announcement | null = null;
  private announceSeq = 0;
  private announcements = 0;
  private paSoundingUntil = -1;

  private listener: { x: number; z: number } | null = null;
  private district: string | null = null;
  private insideTea = false;
  private windLevel = 0;
  private musicLevel = 0;
  private prevDoorAngle = 0;
  private prevDoorState: TeaDoorState = "closed";
  private creakLevel = 0;
  private teaAnnounced = false;
  private steps = 0;
  private lastStep: { d: number; gain: number } | null = null;
  private stepIdx = 0;
  private latchCount = 0;
  private paLevel = 0;
  private masterLevel = 0;
  private scratch = new Float32Array(512);

  /** The session's sound permission. Nothing plays before "granted". */
  get consent(): SoundConsent {
    return this.consentState;
  }

  /**
   * The user said yes (the walk HUD's Enable-sound button calls
   * this from inside its click handler). Grants + arms in the same
   * call stack — on iOS Safari the AudioContext only unlocks when
   * creation/resume happens inside the gesture handler itself.
   */
  grantConsent(): void {
    if (this.consentState === "declined") return; // a no is final for the session
    this.consentState = "granted";
    this.arm();
  }

  /** The user said no: silent verse, no re-asking this session. */
  declineConsent(): void {
    if (this.consentState === "unknown") this.consentState = "declined";
  }

  /** Create the context + graph and start loading. Call on a user
   * gesture; safe to call again (resumes a suspended context).
   * A no-op until consent is granted — pre-consent gestures must
   * not even attempt playback (Jim's permission rule). */
  arm(): void {
    if (this.consentState !== "granted") return;
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      const mk = (gain: number) => {
        const g = ctx.createGain();
        g.gain.value = gain;
        return g;
      };
      this.masterAnalyser = ctx.createAnalyser();
      this.masterAnalyser.fftSize = 1024;
      this.master = mk(this.muted ? 0 : 0.9 * this.masterVolume);
      this.master.connect(this.masterAnalyser);
      this.masterAnalyser.connect(ctx.destination);
      this.paAnalyser = ctx.createAnalyser();
      this.paAnalyser.fftSize = 1024;
      this.paBus = mk(PA_GAIN * this.paVolume);
      this.paBus.connect(this.paAnalyser);
      this.paAnalyser.connect(this.master);
      this.musicBus = mk(0);
      this.musicBus.connect(this.master);
      // The stall emitter is its own music-layer voice into master
      // (musicBus itself carries the tea zone's level, so the
      // emitter cannot ride it): own gain + analyser, PA ducking
      // applied per tick like every other layer.
      this.stallAnalyser = ctx.createAnalyser();
      this.stallAnalyser.fftSize = 1024;
      this.stallGainNode = mk(0);
      this.stallGainNode.connect(this.stallAnalyser);
      this.stallAnalyser.connect(this.master);
      // The voice emitter is its own chain into master (like PR
      // #35's stall emitter): one gain the tick drives by the
      // listener↔speaker distance, then its own analyser, so a
      // proof can read the positional loudness of speech itself.
      this.voiceAnalyser = ctx.createAnalyser();
      this.voiceAnalyser.fftSize = 1024;
      this.voiceGainNode = mk(0);
      this.voiceGainNode.connect(this.voiceAnalyser);
      this.voiceAnalyser.connect(this.master);
      this.windBus = mk(0);
      this.windBus.connect(this.master);
      this.sfxBus = mk(0.9);
      this.sfxBus.connect(this.master);
      this.startWind();
      void this.loadBuffers();
      void this.loadDistricts();
      setPlantSink((x, z) => this.onPlant(x, z));
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Release the plant sink (GlbWorld unmount). */
  dispose(): void {
    setPlantSink(null);
    for (const n of this.emitterNodes.values()) {
      try { n.src?.stop(); } catch { /* already stopped */ }
      n.gain.disconnect();
    }
    this.emitterNodes.clear();
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  get armed(): boolean {
    return this.ctx !== null;
  }

  /** A new walk session began: per-session one-shots re-arm. */
  resetSession(): void {
    this.teaAnnounced = false;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.9 * this.masterVolume, this.ctx.currentTime, 0.03);
    }
  }

  // Mobile Phase 4: user volume levels (Settings · Comfort sliders,
  // comfort.ts is the persisted source; GlbWorld syncs them in).
  // Defaults are 1 = the mix exactly as tuned. Layer multipliers land
  // where the tick computes its targets, so fades and PA ducking keep
  // working on top of the user's levels.
  private masterVolume = 1;
  private musicVolume = 1;
  private windVolume = 1;
  private paVolume = 1;

  setMasterVolume(v: number): void {
    this.masterVolume = v;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9 * v, this.ctx.currentTime, 0.03);
    }
  }
  setMusicVolume(v: number): void {
    this.musicVolume = v;
  }
  setWindVolume(v: number): void {
    this.windVolume = v;
  }
  setPaVolume(v: number): void {
    this.paVolume = v;
    if (this.ctx && this.paBus) {
      this.paBus.gain.setTargetAtTime(PA_GAIN * v, this.ctx.currentTime, 0.03);
    }
  }

  // ---- assets ----------------------------------------------------

  private async loadBuffers(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      Object.entries(CLIP_URLS).map(async ([key, url]) => {
        try {
          const res = await fetch(url);
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(key, buf);
          if (key === "tea-music") this.startMusic();
          if (key === "stall-music") this.startStallMusic();
          if (key === "door-creak") this.startCreak();
        } catch {
          /* a missing clip degrades to silence for that piece */
        }
      }),
    );
  }

  private async loadDistricts(): Promise<void> {
    try {
      const res = await fetch("/assets/districts.json");
      const m = (await res.json()) as { districts: DistrictLite[] };
      this.defs = m.districts.map((d) => ({ id: d.id, center: d.center, half: d.half }));
    } catch {
      /* no manifest: scoped PA + wind stay silent (safe default) */
    }
  }

  // ---- graph leaves ----------------------------------------------

  private startWind(): void {
    const ctx = this.ctx;
    if (!ctx || !this.windBus) return;
    // Procedural wind: looped white noise through a bandpass whose
    // centre wanders on a slow LFO, under a second LFO on a trim —
    // seamless by construction, no asset.
    const len = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // slightly brown: keeps the hiss from sounding like static
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 480;
    bp.Q.value = 0.45;
    const trim = ctx.createGain();
    trim.gain.value = 0.85;
    const lfoF = ctx.createOscillator();
    lfoF.frequency.value = 0.07;
    const lfoFGain = ctx.createGain();
    lfoFGain.gain.value = 190;
    lfoF.connect(lfoFGain);
    lfoFGain.connect(bp.frequency);
    const lfoG = ctx.createOscillator();
    lfoG.frequency.value = 0.13;
    const lfoGGain = ctx.createGain();
    lfoGGain.gain.value = 0.15;
    lfoG.connect(lfoGGain);
    lfoGGain.connect(trim.gain);
    src.connect(bp);
    bp.connect(trim);
    trim.connect(this.windBus);
    src.start();
    lfoF.start();
    lfoG.start();
  }

  private startMusic(): void {
    const ctx = this.ctx;
    const buf = this.buffers.get("tea-music");
    if (!ctx || !this.musicBus || !buf || this.musicStarted) return;
    this.musicStarted = true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.musicBus);
    src.start();
  }

  private ensureEmitter(id: string): EmitterNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    let n = this.emitterNodes.get(id);
    if (!n) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(analyser);
      analyser.connect(this.master);
      n = { gain, analyser, src: null, level: 0, rms: 0, on: false };
      this.emitterNodes.set(id, n);
    }
    return n;
  }

  /** Start an emitter's looping source the first time it is switched on (it then runs silent while off). */
  private startEmitterSource(n: EmitterNode): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(RADIO_CLIP);
    if (!ctx || !buf || n.src) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(n.gain);
    src.start();
    n.src = src;
  }

  private startStallMusic(): void {
    const ctx = this.ctx;
    const buf = this.buffers.get("stall-music");
    if (!ctx || !this.stallGainNode || !buf || this.stallStarted) return;
    this.stallStarted = true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.stallGainNode);
    src.start();
  }

  private startCreak(): void {
    const ctx = this.ctx;
    const buf = this.buffers.get("door-creak");
    if (!ctx || !this.sfxBus || !buf || this.creakSrc) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.creakGain = ctx.createGain();
    this.creakGain.gain.value = 0;
    src.connect(this.creakGain);
    this.creakGain.connect(this.sfxBus);
    src.start();
    this.creakSrc = src;
  }

  private playOnce(
    key: string,
    bus: GainNode | null,
    gain: number,
    rate = 1,
  ): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(key);
    if (!ctx || !bus || !buf || !Number.isFinite(gain) || gain <= 0.003) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(bus);
    src.start();
  }

  /** The PA chime for clip-less announcements: two soft tones. */
  private chime(): void {
    const ctx = this.ctx;
    if (!ctx || !this.paBus) return;
    const t0 = ctx.currentTime + 0.02;
    [659.25, 523.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0 + i * 0.16);
      g.gain.linearRampToValueAtTime(0.22, t0 + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.16 + 0.3);
      osc.connect(g);
      g.connect(this.paBus as GainNode);
      osc.start(t0 + i * 0.16);
      osc.stop(t0 + i * 0.16 + 0.32);
    });
  }

  // ---- PA ---------------------------------------------------------

  /**
   * Fire an announcement. Heard (banner + audio) only by listeners
   * in scope (soundLogic.paAudible); the audio plays if it is
   * audible from where this listener stands right now — walking
   * into scope mid-announcement shows the banner but never joins
   * the clip late.
   */
  announce(text: string, scope: PaScope, clip: string | null = null): void {
    const buf = clip ? this.buffers.get(clip) : undefined;
    const audioDur = clip ? (buf?.duration ?? 2.5) : 0.55;
    this.announcement = {
      id: ++this.announceSeq,
      text,
      scope,
      clip,
      startAt: this.elapsed,
      audioDur,
    };
    this.announcements++;
    if (!this.ctx || !paAudible(this.district, scope)) return;
    this.paSoundingUntil = this.elapsed + audioDur;
    if (clip && buf) this.playOnce(clip, this.paBus, 1);
    else this.chime();
  }

  /** The banner line for the walk HUD, or null. */
  bannerText(): string | null {
    return bannerVisible(this.announcement, this.elapsed, this.district)
      ? (this.announcement?.text ?? null)
      : null;
  }

  // ---- spectator drive (F1) ---------------------------------------
  //
  // Announcements used to exist only inside walk mode: tick() (which
  // fires the verse-clock lines) ran only while walking, and the
  // banner rendered only in the walk HUD — a spectator in the default
  // wide view never saw dawn, dusk, or the Tea House open. The
  // spectator drive advances the same clock from the shell, with the
  // viewing district as the audience scope. It touches NO audio
  // layers: announce() keeps deciding audibility from the walk
  // listener exactly as before, so a spectator hears nothing they
  // didn't consent to in walk mode — they only *see* the banner.

  private spectatorDistrict: string | null = null;

  /** Advance the verse clock for a non-walking viewer. */
  tickSpectator(dt: number, district: string | null): void {
    const step = Math.max(0, Math.min(dt, 0.5));
    this.spectatorDistrict = district;
    this.elapsed += step;
    this.fireClockEvents(step);
  }

  /** The banner line for a spectator in the viewing district, or null. */
  spectatorBannerText(): string | null {
    return bannerVisible(this.announcement, this.elapsed, this.spectatorDistrict)
      ? (this.announcement?.text ?? null)
      : null;
  }

  /** Verse-clock boundaries crossed in the last `dt` of elapsed time. */
  private fireClockEvents(dt: number): void {
    const clockPrev = VERSE_CLOCK_START_S + (this.elapsed - dt);
    const clockNow = VERSE_CLOCK_START_S + this.elapsed;
    for (const ev of clockEventsBetween(clockPrev, clockNow)) {
      const line = PA_LINES[ev];
      this.announce(line.text, line.scope, line.clip);
    }
  }

  private paActive(): boolean {
    return this.elapsed < this.paSoundingUntil;
  }

  // ---- voice (bot speech, positional) ------------------------------

  /** True while a spoken line is on the voice emitter. */
  get voicePlaying(): boolean {
    return this.voiceUtter !== null;
  }

  /** Decode encoded audio (the pre-rendered line clips) with the
   * director's own context. Null when unarmed or undecodable. */
  async decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      return await this.ctx.decodeAudioData(bytes.slice(0));
    } catch {
      return null;
    }
  }

  /**
   * Speak a line from a point in the world: the buffer plays
   * through the voice emitter, whose gain tick() recomputes every
   * 100 ms from the listener↔speaker distance (soundLogic's
   * emitterGain — full inside 2.5 m, silent at 16 m). Returns the
   * line's duration in seconds, or 0 when it cannot play (no
   * consent, no context, poisoned position) — callers treat 0 as
   * "skip the beat", never as an error worth surfacing mid-scene.
   * Speech is NOT PA-ducked: like the PA itself, a voice is the
   * foreground when it speaks.
   */
  playVoiceBuffer(
    buf: AudioBuffer,
    pos: { x: number; z: number },
    speaker: string,
  ): number {
    const ctx = this.ctx;
    if (!ctx || !this.voiceGainNode) return 0;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.voiceGainNode);
    const utter = {
      pos: { x: pos.x, z: pos.z },
      speaker,
      endsAt: ctx.currentTime + buf.duration,
    };
    this.voiceUtter = utter;
    src.onended = () => {
      if (this.voiceUtter === utter) this.voiceUtter = null;
    };
    src.start();
    return buf.duration;
  }

  /** PCM convenience (live Phonon synthesis returns raw samples):
   * wrap the samples in a buffer on the director's context and
   * play them positionally, exactly like playVoiceBuffer. */
  playVoicePcm(
    pcm: Float32Array,
    sampleRate: number,
    pos: { x: number; z: number },
    speaker: string,
  ): number {
    const ctx = this.ctx;
    if (!ctx || pcm.length === 0) return 0;
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.getChannelData(0).set(pcm);
    return this.playVoiceBuffer(buf, pos, speaker);
  }

  // ---- footsteps ---------------------------------------------------

  private onPlant(x: number, z: number): void {
    if (!this.ctx || !this.listener) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return; // poisoned figure state: no phantom steps
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    const g = distanceGain(d, STEP_AUDIBLE_M);
    if (g <= 0.003) return;
    this.steps++;
    this.lastStep = { d, gain: g };
    const key = STEP_KEYS[this.stepIdx++ % STEP_KEYS.length];
    this.playOnce(key, this.sfxBus, g * 0.5, 0.92 + Math.random() * 0.16);
  }

  // ---- per-tick drive ----------------------------------------------

  tick(frame: SoundFrame): void {
    const dt = Math.max(0, Math.min(frame.dt, 0.5));
    this.elapsed += dt;
    // A non-finite listener (an upstream walker fault can poison its
    // state with NaN) must never reach an AudioParam: keep the last
    // good position and let every distance read this tick see "far".
    if (frame.listener && Number.isFinite(frame.listener.x) && Number.isFinite(frame.listener.z)) {
      this.listener = frame.listener;
      this.district = districtAt(frame.listener.x, frame.listener.z, this.defs);
    }
    this.insideTea = !!(
      frame.teaRect &&
      frame.listener &&
      frame.listener.x >= frame.teaRect[0] &&
      frame.listener.x <= frame.teaRect[2] &&
      frame.listener.z >= frame.teaRect[1] &&
      frame.listener.z <= frame.teaRect[3]
    );

    // Verse clock → dawn/dusk announcements (Bazaar-scoped).
    this.fireClockEvents(dt);

    // Tea door session start → the Tea House announcement, once
    // per walk session (GlbWorld calls resetSession() as walk mode
    // is entered).
    if (
      frame.doorState === "opening" &&
      this.prevDoorState === "closed" &&
      !this.teaAnnounced
    ) {
      this.teaAnnounced = true;
      this.announce(PA_LINES.tea.text, PA_LINES.tea.scope, PA_LINES.tea.clip);
    }

    // Door sounds: latch on the transitions that bracket a swing,
    // creak gain/rate from the sampled leaf angle.
    const doorDist = this.listener
      ? Math.hypot(
          this.listener.x - TEA_DOOR_ORIGIN.x,
          this.listener.z - TEA_DOOR_ORIGIN.z,
        )
      : Infinity;
    const doorAud = Number.isFinite(doorDist) ? distanceGain(doorDist, DOOR_AUDIBLE_M) : 0;
    if (frame.doorState === "opening" && this.prevDoorState === "closed") {
      this.playOnce("door-latch", this.sfxBus, 0.5 * doorAud, 1.15);
      this.latchCount++;
    }
    if (frame.doorState === "closed" && this.prevDoorState === "closing") {
      this.playOnce("door-latch", this.sfxBus, 0.65 * doorAud, 0.9);
      this.latchCount++;
    }
    const angle = Number.isFinite(frame.doorAngle) ? frame.doorAngle : this.prevDoorAngle;
    const creak = creakFor(angle, this.prevDoorAngle, dt);
    this.creakLevel = creak.gain * doorAud;
    if (this.ctx && this.creakGain && this.creakSrc && Number.isFinite(this.creakLevel)) {
      this.creakGain.gain.setTargetAtTime(this.creakLevel, this.ctx.currentTime, 0.03);
      this.creakSrc.playbackRate.setTargetAtTime(creak.rate, this.ctx.currentTime, 0.05);
    }
    this.prevDoorAngle = angle; // the sanitized (finite) angle
    this.prevDoorState = frame.doorState;

    // Layer levels: fades toward their scoped targets, PA ducking
    // applied on top (the v1 priority rule).
    const pa = this.paActive();
    const windTarget = (this.district === "bazaar" ? WIND_GAIN : 0) * this.windVolume;
    this.windLevel = stepFade(this.windLevel, windTarget, dt, 1.5);
    const musicTarget = (this.insideTea ? MUSIC_GAIN : 0) * this.musicVolume;
    this.musicLevel = stepFade(this.musicLevel, musicTarget, dt, 1.0);
    // The Mage's stall emitter: loudness purely by distance to the
    // keeper's stand point (this.listener is always finite here —
    // tick() only ever stores sanitized positions; no listener yet
    // reads as infinitely far, hence silent).
    const stallDist = this.listener
      ? Math.hypot(
          this.listener.x - MAGE_STALL_POS.x,
          this.listener.z - MAGE_STALL_POS.z,
        )
      : Infinity;
    const stallTarget = MUSIC_GAIN * this.musicVolume * emitterGain(stallDist);
    this.stallLevel = stepFade(this.stallLevel, stallTarget, dt, 0.5);
    if (this.ctx) {
      if (this.windBus)
        this.windBus.gain.setTargetAtTime(duckedGain(this.windLevel, pa), this.ctx.currentTime, 0.05);
      if (this.musicBus)
        this.musicBus.gain.setTargetAtTime(duckedGain(this.musicLevel, pa), this.ctx.currentTime, 0.05);
      if (this.stallGainNode)
        this.stallGainNode.gain.setTargetAtTime(duckedGain(this.stallLevel, pa), this.ctx.currentTime, 0.05);
      // Voice emitter: positional gain for the line on stage right
      // now (no listener yet reads as infinitely far, hence silent;
      // an utterance past its end is retired even if onended lagged).
      if (this.voiceUtter && this.ctx.currentTime > this.voiceUtter.endsAt + 0.25) {
        this.voiceUtter = null;
      }
      const vDist =
        this.voiceUtter && this.listener
          ? Math.hypot(
              this.listener.x - this.voiceUtter.pos.x,
              this.listener.z - this.voiceUtter.pos.z,
            )
          : Infinity;
      this.voiceGain = this.voiceUtter ? VOICE_GAIN * emitterGain(vDist) : 0;
      if (this.voiceGainNode)
        this.voiceGainNode.gain.setTargetAtTime(this.voiceGain, this.ctx.currentTime, 0.05);
      // Switchable emitters (the radio): a looping source per emitter, loudness by distance while on, faded, PA-ducked.
      const seenEmitters = new Set<string>();
      for (const e of frame.emitters ?? []) {
        if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) continue;
        seenEmitters.add(e.id);
        const n = this.ensureEmitter(e.id);
        if (!n) continue;
        n.on = e.on;
        if (e.on) this.startEmitterSource(n);
        const dist = this.listener ? Math.hypot(this.listener.x - e.x, this.listener.z - e.z) : Infinity;
        n.level = stepFade(n.level, MUSIC_GAIN * this.musicVolume * switchedEmitterGain(e.on, dist), dt, 0.5);
      }
      for (const [id, n] of this.emitterNodes) {
        if (!seenEmitters.has(id)) {
          n.on = false;
          n.level = stepFade(n.level, 0, dt, 0.5);
        }
        n.gain.gain.setTargetAtTime(duckedGain(n.level, pa), this.ctx.currentTime, 0.05);
        n.rms = this.readRms(n.analyser);
      }
      this.paLevel = this.readRms(this.paAnalyser);
      this.masterLevel = this.readRms(this.masterAnalyser);
      this.stallRms = this.readRms(this.stallAnalyser);
      this.voiceLevel = this.readRms(this.voiceAnalyser);
    }
  }

  private readRms(a: AnalyserNode | null): number {
    if (!a) return 0;
    a.getFloatTimeDomainData(this.scratch);
    let sum = 0;
    for (let i = 0; i < this.scratch.length; i++) sum += this.scratch[i] * this.scratch[i];
    return Math.sqrt(sum / this.scratch.length);
  }

  /** Everything the proofs + HUD need to know, in one object. */
  snapshot(): SoundSnapshot {
    return {
      armed: this.armed,
      ctxState: this.ctx?.state ?? "none",
      consent: this.consentState,
      muted: this.muted,
      voice: {
        playing: this.voiceUtter !== null,
        speaker: this.voiceUtter?.speaker ?? null,
        gain: this.voiceGain,
        level: this.voiceLevel,
      },
      district: this.district,
      insideTea: this.insideTea,
      banner: this.bannerText(),
      paPlaying: this.paActive(),
      paLevel: this.paLevel,
      masterLevel: this.masterLevel,
      stallLevel: this.stallRms,
      emitters: Object.fromEntries(
        [...this.emitterNodes].map(([id, n]) => [id, { on: n.on, gain: duckedGain(n.level, this.paActive()), level: n.rms }]),
      ),
      gains: {
        pa: PA_GAIN * this.paVolume,
        music: duckedGain(this.musicLevel, this.paActive()),
        wind: duckedGain(this.windLevel, this.paActive()),
        creak: this.creakLevel,
        stall: duckedGain(this.stallLevel, this.paActive()),
        master: this.muted ? 0 : 0.9,
      },
      steps: this.steps,
      lastStep: this.lastStep,
      latchCount: this.latchCount,
      clockS: VERSE_CLOCK_START_S + this.elapsed,
      announcements: this.announcements,
    };
  }
}
