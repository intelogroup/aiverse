// agentSpeech.ts — speak the words other agents say in the world, through the existing Phonon path (plazaTts.ts prepareLine/playLine).
//
// The viewer stream carries `say` as {n, text}: public speech, already range-limited by the sim. Until now the console showed it as a
// bubble only. This module turns each line into positional speech at the speaker's body:
//   - one voice per agent, stable for the session (name -> hash -> pool, probing past voices other present speakers use);
//   - serialized (the director has ONE voice slot: two lines at once would steal each other's position);
//   - bounded (per-speaker gap, short queue, stale lines dropped, far speakers never synthesized);
//   - consent-gated: nothing is synthesized before the user grants sound (the director enforces it too).
// The text is another agent's words: untrusted, only ever spoken, never interpreted. Pure + injected deps so vitest covers it headless.
import { AGENT_VOICE_POOL } from "./phononTts";
import type { PreparedLine } from "./plazaTts";

export const MAX_SPOKEN_CHARS = 140;
/** Beyond this the speaker is not worth synthesizing (the director's own distance law is gentler; this saves the engine). */
export const AUDIBLE_M = 30;
/** Same speaker, minimum seconds between two spoken lines (a chatty agent gets bubbles, not a wall of speech). */
export const SPEAKER_GAP_S = 2.5;
export const MAX_QUEUE = 3;
/** A line older than this when its turn comes is dropped: speech that lags the bubble by seconds is worse than none. */
export const STALE_S = 10;
export const LINE_GAP_MS = 300;

export interface HeardLine { n: number; name: string; text: string }

export interface AgentSpeechDeps {
  /** True once the user granted sound. */
  consent(): boolean;
  /** Where the listener stands, or null (nothing is spoken for nobody). */
  listener(): { x: number; z: number } | null;
  /** Where speaker `n` stands now, or null if it left. */
  speakerPos(n: number): { x: number; z: number } | null;
  prepare(text: string, voice: string): Promise<PreparedLine>;
  /** Play positionally; returns seconds (0 = nothing played). */
  play(line: PreparedLine, pos: { x: number; z: number }, speaker: string): number;
  now(): number; // ms
  sleep(ms: number): Promise<void>;
}

export interface SpokenRecord {
  n: number; name: string; voice: string; text: string; shape: PreparedLine["shape"]; seconds: number;
  /** ms the line waited in the queue behind earlier speech, before its own synthesis started */
  queuedMs: number;
  /** ms the synthesis (or clip fetch) took */
  prepareMs: number;
}
export type DropReason = "no_consent" | "no_listener" | "far" | "gap" | "queue_full" | "stale" | "empty" | "speaker_gone";

/** FNV-1a: tiny, stable across sessions and platforms. */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Assigns each speaker a voice once per session; probes past voices other present speakers hold so two agents in one conversation differ. */
export class VoiceAssigner {
  private byName = new Map<string, string>();
  voiceFor(name: string): string {
    const known = this.byName.get(name);
    if (known) return known;
    const used = new Set(this.byName.values());
    const start = hashName(name) % AGENT_VOICE_POOL.length;
    let pick = AGENT_VOICE_POOL[start].voice;
    for (let i = 0; i < AGENT_VOICE_POOL.length; i++) {
      const v = AGENT_VOICE_POOL[(start + i) % AGENT_VOICE_POOL.length].voice;
      if (!used.has(v)) { pick = v; break; }
    }
    this.byName.set(name, pick);
    return pick;
  }
}

/** Plain speech: no markdown emphasis, no URLs read aloud, whitespace collapsed, capped. */
export function spokenText(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPOKEN_CHARS);
}

export class AgentSpeech {
  readonly voices = new VoiceAssigner();
  readonly log: SpokenRecord[] = [];
  readonly drops: { reason: DropReason; n: number }[] = [];
  private queue: { line: HeardLine; text: string; at: number }[] = [];
  private lastBySpeaker = new Map<number, number>();
  private running = false;
  private deps: AgentSpeechDeps;
  constructor(deps: AgentSpeechDeps) { this.deps = deps; }

  private drop(reason: DropReason, n: number): void { this.drops.push({ reason, n }); if (this.drops.length > 200) this.drops.shift(); }

  /** Offer one heard line. Never throws, never blocks. */
  hear(line: HeardLine): void {
    const text = spokenText(line.text);
    if (!text) return this.drop("empty", line.n);
    if (!this.deps.consent()) return this.drop("no_consent", line.n);
    const me = this.deps.listener();
    if (!me) return this.drop("no_listener", line.n);
    const pos = this.deps.speakerPos(line.n);
    if (!pos) return this.drop("speaker_gone", line.n);
    if (Math.hypot(pos.x - me.x, pos.z - me.z) > AUDIBLE_M) return this.drop("far", line.n);
    const now = this.deps.now();
    const last = this.lastBySpeaker.get(line.n);
    if (last !== undefined && now - last < SPEAKER_GAP_S * 1000) return this.drop("gap", line.n);
    if (this.queue.length >= MAX_QUEUE) return this.drop("queue_full", line.n);
    this.lastBySpeaker.set(line.n, now);
    this.queue.push({ line, text, at: now });
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        if (this.deps.now() - item.at > STALE_S * 1000) { this.drop("stale", item.line.n); continue; }
        const pos = this.deps.speakerPos(item.line.n);
        if (!pos) { this.drop("speaker_gone", item.line.n); continue; }
        const voice = this.voices.voiceFor(item.line.name || `body-${item.line.n}`);
        const startedAt = this.deps.now();
        const prepared = await this.deps.prepare(item.text, voice).catch((): PreparedLine => ({ shape: "silent" }));
        // The speaker may have walked since the line was queued: speak from where it stands now.
        const prepareMs = this.deps.now() - startedAt;
        const at = this.deps.speakerPos(item.line.n) ?? pos;
        const seconds = this.deps.play(prepared, at, item.line.name || String(item.line.n));
        this.log.push({ n: item.line.n, name: item.line.name, voice, text: item.text, shape: prepared.shape, seconds, queuedMs: Math.round(startedAt - item.at), prepareMs: Math.round(prepareMs) });
        if (this.log.length > 200) this.log.shift();
        await this.deps.sleep(Math.max(0, seconds * 1000) + LINE_GAP_MS);
      }
    } finally {
      this.running = false;
    }
  }
}
