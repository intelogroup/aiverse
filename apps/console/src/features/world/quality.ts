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
