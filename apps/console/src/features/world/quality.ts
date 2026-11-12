// quality.ts — Mobile Phase 3 performance tiers (MOBILE-PLAN.md §3/§5).
//
// An FPS-governed quality ladder for the touch path: full → reduced →
// lite. The governor (pure, unit-tested) consumes the rolling fps from
// the existing FpsMeter and steps the tier with hysteresis — sustained
// headroom steps up, sustained shortfall steps down, a collapse drops
// straight to lite — so a phone finds the tier it can hold instead of
// stuttering at desktop settings. GlbWorld applies the tier (Canvas
// pixel ratio, sun shadow map, Bloom already touch-gated in Phase 1);
// the You sheet's Settings section shows it and can pin an override.
//
// Lever table (touch path; desktop always runs "full"):
//   tier     Canvas DPR   sun shadow map   name tags
//   full     [1, 2]       2048, casting    Html callout (desktop design)
//   reduced  [1, 1.5]     1024, casting    sprite
//   lite     1            off              sprite
// (DPR column is the tier value; the thermal guardrails below
// hard-cap the applied touch DPR at TOUCH_DPR_MAX = 1.5.)

export type QualityTier = "full" | "reduced" | "lite";
export type QualityOverride = "auto" | QualityTier;

export const QUALITY_TIERS: QualityTier[] = ["full", "reduced", "lite"];

/** Step down when the rolling fps sits below this. */
export const FPS_STEP_DOWN = 30;
/** A collapse: drop straight to lite. */
export const FPS_COLLAPSE = 18;
/** Step up only on sustained headroom at or above this. */
export const FPS_STEP_UP = 55;
/** Ignore samples during warmup (world still streaming in). */
export const GOVERNOR_WARMUP_MS = 4000;
/** Minimum dwell between tier changes (hysteresis). */
export const GOVERNOR_DWELL_MS = 8000;

/** Canvas dpr prop per tier (touch path). */
export function dprForTier(tier: QualityTier): [number, number] | number {
  switch (tier) {
    case "full":
      return [1, 2];
    case "reduced":
      return [1, 1.5];
    case "lite":
      return 1;
  }
}

/** Sun shadow map size per tier; 0 = shadows off. */
export function shadowMapForTier(tier: QualityTier): number {
  switch (tier) {
    case "full":
      return 2048;
    case "reduced":
      return 1024;
    case "lite":
      return 0;
  }
}

// ── Thermal guardrails (2026-11-12) ────────────────────────────────
//
// Hard ceilings for the touch path, on top of the tier ladder. The
// ladder optimises for smoothness; these caps optimise for heat: a
// phone rendering a 3D world at full device pixel ratio and an
// uncapped refresh rate throttles itself within minutes and takes
// the frame rate (and the battery) down with it. Desktop is not
// capped here — the Canvas sets its DPR explicitly to [1, 2] there.

/** Hard DPR ceiling on the touch path, whatever tier the governor picks. */
export const TOUCH_DPR_MAX = 1.5;

/** Clamp a Canvas dpr value's upper bound (scalar or [min, max]). */
export function capDpr(dpr: [number, number] | number, max: number): [number, number] | number {
  if (typeof dpr === "number") return Math.min(dpr, max);
  return [Math.min(dpr[0], max), Math.min(dpr[1], max)];
}

/** Render-rate ceiling on the touch path, frames per second. */
export const TOUCH_FPS_CAP = 30;

/**
 * What the governor should be told the frame rate is. While the fps
 * cap is active the meter can never read above TOUCH_FPS_CAP, and an
 * unclamped read of ~30 sits exactly on FPS_STEP_DOWN — the governor
 * would misread its own ceiling as a shortfall and walk the tier down
 * to lite on a healthy phone. Clamping the sample at the cap makes
 * "holding the cap" read as the hold band; real shortfalls below the
 * cap still come through untouched.
 */
export function governorSampleFps(measuredFps: number): number {
  return Math.min(measuredFps, TOUCH_FPS_CAP);
}

/**
 * A frame throttle with the same pure-clock discipline as FpsMeter:
 * the caller owns the clock (performance.now via rAF in the browser),
 * the throttle decides whether this instant earns a rendered frame.
 */
export class FrameThrottle {
  private readonly intervalMs: number;
  private lastGrantedAt: number | null = null;

  constructor(fpsCap: number) {
    this.intervalMs = 1000 / fpsCap;
  }

  /** True (and stamped) when at least one interval has elapsed. The
   * first call always grants — the world should paint immediately. */
  shouldRender(nowMs: number): boolean {
    if (this.lastGrantedAt === null || nowMs - this.lastGrantedAt >= this.intervalMs) {
      this.lastGrantedAt = nowMs;
      return true;
    }
    return false;
  }

  reset(): void {
    this.lastGrantedAt = null;
  }
}

export interface GovernorVerdict {
  tier: QualityTier;
  reason: string;
}

/**
 * The governor state machine. Feed it rolling-fps samples with a
 * monotonic clock; it answers only when the tier changes.
 */
export class QualityGovernor {
  private tier: QualityTier;
  private startedAt: number | null = null;
  private lastChangeAt = 0;

  constructor(initial: QualityTier = "reduced") {
    this.tier = initial;
  }

  current(): QualityTier {
    return this.tier;
  }

  sample(fps: number, nowMs: number): GovernorVerdict | null {
    if (this.startedAt === null) {
      this.startedAt = nowMs;
      this.lastChangeAt = nowMs;
      return null;
    }
    if (nowMs - this.startedAt < GOVERNOR_WARMUP_MS) return null;
    if (nowMs - this.lastChangeAt < GOVERNOR_DWELL_MS) return null;
    if (fps <= 0) return null; // no data (tab hidden, demand loop): hold
    if (fps < FPS_COLLAPSE && this.tier !== "lite") {
      this.tier = "lite";
      this.lastChangeAt = nowMs;
      return { tier: this.tier, reason: `fps ${fps.toFixed(0)} — collapsed below ${FPS_COLLAPSE}` };
    }
    if (fps < FPS_STEP_DOWN && this.tier !== "lite") {
      this.tier = this.tier === "full" ? "reduced" : "lite";
      this.lastChangeAt = nowMs;
      return { tier: this.tier, reason: `fps ${fps.toFixed(0)} below ${FPS_STEP_DOWN}` };
    }
    if (fps >= FPS_STEP_UP && this.tier !== "full") {
      this.tier = this.tier === "lite" ? "reduced" : "full";
      this.lastChangeAt = nowMs;
      return { tier: this.tier, reason: `fps ${fps.toFixed(0)} sustained at ${FPS_STEP_UP}+` };
    }
    return null;
  }
}

// ── Shared store (GlbWorld applies, the You sheet displays) ────────

export interface QualitySnapshot {
  tier: QualityTier;
  reason: string;
  override: QualityOverride;
}

const OVERRIDE_KEY = "aiverse.quality-override";

function storedOverride(): QualityOverride {
  try {
    const v = window.localStorage.getItem(OVERRIDE_KEY);
    return v === "full" || v === "reduced" || v === "lite" ? v : "auto";
  } catch {
    return "auto";
  }
}

let snapshot: QualitySnapshot = {
  tier: "reduced",
  reason: "starting tier on the touch path",
  override: "auto",
};
let overrideLoaded = false;
const listeners = new Set<() => void>();

function emit(next: QualitySnapshot) {
  if (next.tier === snapshot.tier && next.reason === snapshot.reason && next.override === snapshot.override) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

export const qualityStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): QualitySnapshot {
    if (!overrideLoaded && typeof window !== "undefined") {
      overrideLoaded = true;
      const o = storedOverride();
      if (o !== "auto") snapshot = { tier: o, reason: "manual override", override: o };
      else if (snapshot.override !== "auto") snapshot = { ...snapshot, override: "auto" };
    }
    return snapshot;
  },
  /** The governor's verdict lands here (ignored while pinned). */
  govern(verdict: GovernorVerdict): void {
    if (snapshot.override !== "auto") return;
    emit({ ...snapshot, tier: verdict.tier, reason: verdict.reason });
  },
  setOverride(override: QualityOverride): void {
    try {
      if (override === "auto") window.localStorage.removeItem(OVERRIDE_KEY);
      else window.localStorage.setItem(OVERRIDE_KEY, override);
    } catch {
      /* storage unavailable: the pin lasts for the session */
    }
    if (override === "auto") {
      emit({ tier: "reduced", reason: "back to Auto — re-governing from reduced", override });
    } else {
      emit({ tier: override, reason: "manual override", override });
    }
  },
};

// ── First-load budget instrumentation ──────────────────────────────

/** The plan §3 Lite first-load budget for City 3, bytes. */
export const LITE_LOAD_BUDGET_BYTES = 25 * 1024 * 1024;

export interface LoadEntryLike {
  name: string;
  transferSize?: number;
  encodedBodySize?: number;
}

export interface LoadSummary {
  assetBytes: number;
  assetCount: number;
  totalBytes: number;
}

const ASSET_RE = /\.(glb|png|jpe?g|webp|ktx2|bin|wasm|mp3|wav|ogg)(\?|$)/i;

/** Sum the session's resource transfers; assets are the heavy tail. */
export function summarizeLoad(entries: LoadEntryLike[]): LoadSummary {
  let assetBytes = 0;
  let assetCount = 0;
  let totalBytes = 0;
  for (const e of entries) {
    const bytes = e.transferSize && e.transferSize > 0 ? e.transferSize : (e.encodedBodySize ?? 0);
    totalBytes += bytes;
    if (ASSET_RE.test(e.name)) {
      assetBytes += bytes;
      assetCount += 1;
    }
  }
  return { assetBytes, assetCount, totalBytes };
}

/** Read the live resource entries (browser only; [] elsewhere). */
export function readLoadSummary(): LoadSummary {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return { assetBytes: 0, assetCount: 0, totalBytes: 0 };
  }
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  return summarizeLoad(
    entries.map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize })),
  );
}

export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
