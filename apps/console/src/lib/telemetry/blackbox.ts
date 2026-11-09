/**
 * Black-box session log v1 — the verse's flight recorder.
 *
 * A fixed-capacity ring buffer of timestamped WORLD events (district
 * changes, camera jumps, asset loads, WebGL losses, errors, FPS windows).
 * The shape is one JSON object per line ({ts, t, type, data}) so a session
 * export lines up with the experiment rigs' trace.jsonl files and Phase 2
 * replay tooling can consume both with one reader.
 *
 * PRIVACY: world events only. Nothing in this module reads DOM content,
 * form values, chat text, or tokens, and callers must not pass them in.
 * Event payloads are positions, asset URLs, timings, and error text that
 * the user’s own client generated about the world — nothing else.
 */

export interface BlackboxEvent {
  /** Wall-clock ISO timestamp (for cross-referencing server logs). */
  ts: string;
  /** Milliseconds since the recorder started (monotonic, for replay). */
  t: number;
  /** Event kind, e.g. "session.start", "asset.load", "error". */
  type: string;
  /** World-state payload. Keep it positions/timings/ids — see header. */
  data?: Record<string, unknown>;
}

export const BLACKBOX_CAPACITY = 600;

export class Blackbox {
  private events: BlackboxEvent[] = [];
  private readonly startedAt = performance.now();
  private readonly capacity: number;

  constructor(capacity: number = BLACKBOX_CAPACITY) {
    this.capacity = capacity;
  }

  record(type: string, data?: Record<string, unknown>): BlackboxEvent {
    const ev: BlackboxEvent = {
      ts: new Date().toISOString(),
      t: Math.round(performance.now() - this.startedAt),
      type,
      ...(data ? { data } : {}),
    };
    this.events.push(ev);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return ev;
  }

  /** The most recent `n` events, oldest first. */
  tail(n: number): BlackboxEvent[] {
    return this.events.slice(Math.max(0, this.events.length - n));
  }

  all(): BlackboxEvent[] {
    return [...this.events];
  }

  get size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }

  /** NDJSON — one event per line, the rigs' trace format. */
  toJSONL(events: BlackboxEvent[] = this.events): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  }
}

/** The session's recorder. One per page load, started by initTelemetry(). */
export const blackbox = new Blackbox();

export function recordWorldEvent(type: string, data?: Record<string, unknown>): BlackboxEvent {
  return blackbox.record(type, data);
}

/** Kind of the most recent window-level error ("window.error",
 *  "unhandledrejection", "manual"), noted by the listeners in index.ts
 *  so the Sentry beforeSend hook in sentry.ts can tag the SDK-captured
 *  event with it — the SDK's own global handlers do the capturing, so
 *  the kind has to travel out-of-band like this. */
let lastErrorKindValue = "error";
export function noteErrorKind(kind: string): void {
  lastErrorKindValue = kind;
}
export function lastErrorKind(): string {
  return lastErrorKindValue;
}
