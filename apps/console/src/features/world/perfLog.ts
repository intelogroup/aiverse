// perfLog — pure core of the `?perf=1` on-device overlay (PerfProbe / PerfOverlay). Written 2026-11-22 for one question: on a current
// iPhone the world sometimes freezes for a moment while walking or running and then recovers. Emulation cannot reproduce a phone, so
// the overlay records, ON the phone, every frame gap >100 ms together with what else happened around it (tier change, big asset
// finishing, context loss, draw/triangle/texture counts, position) so one 10-minute walk names the cause. Off unless ?perf=1.
// Gaps are measured on a plain requestAnimationFrame loop, not R3F's: the touch path renders at a 30 fps cap, but rAF still fires at the
// display rate, so a gap there is a real main-thread stall (or the compositor starving it), not the cap.

export type PerfKind = "gap" | "tier" | "load" | "ctx" | "vis" | "note";
export interface PerfEvent { t: number; kind: PerfKind; text: string }

/** A rAF gap longer than this (ms) is logged. 60 Hz frames are 17 ms; the 30 fps cap never shows in rAF. */
export const GAP_MS = 100;

export class FrameGapDetector {
  private last: number | null = null;
  private readonly threshold: number;
  constructor(threshold = GAP_MS) { this.threshold = threshold; }
  /** Feed every rAF timestamp. Returns the gap (ms) when it exceeds the threshold; `skip` swallows it (hidden tab, just resumed). */
  feed(nowMs: number, skip = false): number | null {
    const prev = this.last;
    this.last = nowMs;
    if (prev === null || skip) return null;
    const gap = nowMs - prev;
    return gap > this.threshold ? gap : null;
  }
  reset(): void { this.last = null; }
}

export class EventRing {
  private items: PerfEvent[] = [];
  private readonly max: number;
  constructor(max = 300) { this.max = max; }
  push(e: PerfEvent): void { this.items.push(e); if (this.items.length > this.max) this.items.shift(); }
  all(): PerfEvent[] { return this.items.slice(); }
  tail(n: number): PerfEvent[] { return this.items.slice(-n); }
  clear(): void { this.items = []; }
}

export interface GapStats { count: number; worst: number; over250: number; over500: number }

export function gapStats(events: readonly PerfEvent[]): GapStats {
  const s: GapStats = { count: 0, worst: 0, over250: 0, over500: 0 };
  for (const e of events) {
    if (e.kind !== "gap") continue;
    const ms = Number.parseInt(e.text, 10);
    if (!Number.isFinite(ms)) continue;
    s.count++;
    s.worst = Math.max(s.worst, ms);
    if (ms > 250) s.over250++;
    if (ms > 500) s.over500++;
  }
  return s;
}

export interface LoadRec { end: number; name: string; bytes: number }

/** Loads that finished inside [from, to] (ms): the usual suspects for a hitch (parse + GPU upload land right after the download). */
export function loadsInWindow(loads: readonly LoadRec[], from: number, to: number, max = 3): string {
  const hit = loads.filter((l) => l.end >= from && l.end <= to).slice(-max);
  if (!hit.length) return "";
  return " loads:" + hit.map((l) => `${l.name}${l.bytes ? ` ${(l.bytes / 1e6).toFixed(1)}MB` : ""}`).join(",");
}

export function formatEvent(e: PerfEvent): string {
  return `${(e.t / 1000).toFixed(1).padStart(7)}s ${e.kind.padEnd(4)} ${e.text}`;
}

export function reportText(header: string, events: readonly PerfEvent[]): string {
  const g = gapStats(events);
  const sum = `gaps>${GAP_MS}ms: ${g.count}  worst ${g.worst}ms  >250ms: ${g.over250}  >500ms: ${g.over500}`;
  return [header, sum, ...events.map(formatEvent)].join("\n");
}

// ── Field data (RUM): the same stall records, summarised once per visit and reported to Sentry (see PerfProbe.flushRum) ──────────────

export interface GapRec { t: number; ms: number; x: number; z: number; draws: number; tris: number; tier: string; loads: string }

export interface PerfSummary {
  visibleS: number;
  gaps: number;
  worst: number;
  p95: number;
  over250: number;
  over500: number;
  bucket: string;
  tierChanges: number;
  ctxLost: number;
  medianDraws: number;
  /** The five worst stalls. Positions are rounded to 10 m here (the one place), so no precise track of a person leaves the device. */
  top: GapRec[];
}

export function gapBucket(worstMs: number): string {
  if (worstMs >= 1000) return ">=1000";
  if (worstMs >= 500) return "500-999";
  if (worstMs >= 250) return "250-499";
  if (worstMs >= GAP_MS) return "100-249";
  return "none";
}

const median = (a: readonly number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};

export function summarize(gaps: readonly GapRec[], meta: { visibleS: number; tierChanges: number; ctxLost: number; drawsSamples: readonly number[] }): PerfSummary {
  const ms = gaps.map((g) => g.ms).sort((a, b) => a - b);
  const worst = ms.length ? ms[ms.length - 1] : 0;
  const top = [...gaps].sort((a, b) => b.ms - a.ms).slice(0, 5).map((g) => ({ ...g, ms: Math.round(g.ms), t: Math.round(g.t / 100) / 10, x: Math.round(g.x / 10) * 10, z: Math.round(g.z / 10) * 10 }));
  return {
    visibleS: Math.round(meta.visibleS),
    gaps: gaps.length,
    worst: Math.round(worst),
    p95: ms.length ? Math.round(ms[Math.floor(0.95 * (ms.length - 1))]) : 0,
    over250: ms.filter((m) => m > 250).length,
    over500: ms.filter((m) => m > 500).length,
    bucket: gapBucket(worst),
    tierChanges: meta.tierChanges,
    ctxLost: meta.ctxLost,
    medianDraws: Math.round(median(meta.drawsSamples)),
    top,
  };
}

/** Share of visits that report. Everyone with 3+ stalls reports too (the interesting tail), still at most once per device per day. */
export const RUM_SAMPLE = 0.25;
export const RUM_MIN_VISIBLE_S = 15;
export const RUM_MIN_STALLS = 3;
export const RUM_DAY_MS = 24 * 60 * 60 * 1000;

export function shouldSendPerf(o: { visibleS: number; gaps: number; sampled: boolean; lastSentMs: number; nowMs: number }): boolean {
  if (o.visibleS < RUM_MIN_VISIBLE_S) return false;
  if (o.nowMs - o.lastSentMs < RUM_DAY_MS) return false;
  return o.sampled || o.gaps >= RUM_MIN_STALLS;
}
