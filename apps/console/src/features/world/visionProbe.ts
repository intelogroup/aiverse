// visionProbe.ts — Embody v0 vision FPS probe math (SPIKE, tmp/embody-v0).
//
// The design note's served `look`: a bot with vision gets ONE frame from
// its head camera, on demand, never a stream — because frames are the
// expensive sense. This module is the measurement half of that bargain:
// pure helpers (three-free, DOM-free, same discipline as embody.ts) that
// answer "what would a look actually cost, in frame rate and ms per
// capture?" The panel in GlbWorld.tsx does the capturing (drawImage of
// the WebGL canvas into a 2D canvas in Ride mode, where the main camera
// IS the head camera); this module owns the cadence gating and the
// running statistics so they can be unit-tested headless.

/** Served-look frame size: big enough for a vision model, small to move. */
export const PROBE_WIDTH = 512;
export const PROBE_HEIGHT = 288;

/** EMA weight for each new sample (fps and capture-cost averages). */
export const FPS_EMA_ALPHA = 0.2;

/** Cadence choices the panel offers, fps. 0 = probe off. */
export const PROBE_CADENCES = [1, 2, 5, 10] as const;

export interface ProbeStats {
  /** Total frames captured since the stats were (re)started. */
  captures: number;
  /** performance.now() timestamp of the latest capture, ms. */
  lastAt: number | null;
  /** Achieved capture rate, EMA over inter-capture intervals, fps. */
  fpsEma: number;
  /** Mean capture cost (the drawImage), EMA, ms. */
  costEmaMs: number;
}

export function initialProbeStats(): ProbeStats {
  return { captures: 0, lastAt: null, fpsEma: 0, costEmaMs: 0 };
}

/** One exponential-moving-average step toward `sample`. */
export function ema(prev: number, sample: number, alpha: number): number {
  return prev + (sample - prev) * alpha;
}

/**
 * Cadence gate: is a capture due at `nowMs`, given the previous capture
 * timestamp and the target rate? The first capture is always due; a
 * target of 0 (or less) never fires — that is the probe's off switch,
 * and the reason a `look` can be rationed to any rate the verse picks.
 */
export function shouldCapture(nowMs: number, lastAt: number | null, targetFps: number): boolean {
  if (targetFps <= 0) return false;
  if (lastAt === null) return true;
  return nowMs - lastAt >= 1000 / targetFps;
}

/**
 * Fold one finished capture into the stats (pure — returns new state).
 * `nowMs` is the capture's start timestamp; `costMs` is how long the
 * capture itself took. The fps EMA seeds from the first measurable
 * interval (the second capture) so a single frame never claims a rate;
 * the cost EMA seeds from the first capture's own cost.
 */
export function recordCapture(stats: ProbeStats, nowMs: number, costMs: number): ProbeStats {
  let fpsEma = stats.fpsEma;
  if (stats.lastAt !== null) {
    const interval = nowMs - stats.lastAt;
    if (interval > 0) {
      const sample = 1000 / interval;
      fpsEma = stats.captures >= 2 ? ema(stats.fpsEma, sample, FPS_EMA_ALPHA) : sample;
    }
  }
  const costEmaMs = stats.captures === 0 ? costMs : ema(stats.costEmaMs, costMs, FPS_EMA_ALPHA);
  return { captures: stats.captures + 1, lastAt: nowMs, fpsEma, costEmaMs };
}
