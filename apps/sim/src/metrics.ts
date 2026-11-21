// metrics.ts — rolling 60 s operational metrics, no dependency. One slot per second (60 slots, reused), each with a fixed
// log-scale latency histogram, so memory is constant and recording is O(1) at thousands of requests per second.
// shortcut: percentiles are histogram bucket upper bounds (<= 25% over the true value), max is exact; upgrade only if finer p99 is needed.

export const WINDOW_S = 60;
const BINS = 64;
const FIRST_MS = 0.05;
const RATIO = 1.25;
const bound = (i: number) => FIRST_MS * RATIO ** i;
const binOf = (ms: number) => (ms <= FIRST_MS ? 0 : Math.min(BINS - 1, Math.ceil(Math.log(ms / FIRST_MS) / Math.log(RATIO))));

interface Slot { sec: number; n: number; max: number; rateLimited: number; worldFull: number; hist: Uint32Array }
const slot = (): Slot => ({ sec: -1, n: 0, max: 0, rateLimited: 0, worldFull: 0, hist: new Uint32Array(BINS) });

export interface WindowSummary { n: number; p50: number; p99: number; max: number; rateLimited: number; worldFull: number }

export class RollingWindow {
  private readonly slots = Array.from({ length: WINDOW_S }, slot);

  /** Record one sample taken at `atMs` (epoch ms): `ms` latency, optional HTTP `status` (429 / 503 are counted). */
  record(atMs: number, ms: number, status?: number): void {
    const sec = Math.floor(atMs / 1000);
    const s = this.slots[sec % WINDOW_S];
    if (s.sec !== sec) { s.sec = sec; s.n = s.max = s.rateLimited = s.worldFull = 0; s.hist.fill(0); }
    s.n++; s.hist[binOf(ms)]++;
    if (ms > s.max) s.max = ms;
    if (status === 429) s.rateLimited++;
    else if (status === 503) s.worldFull++;
  }

  /** The last 60 s ending at `atMs`. Times are ms, rounded to 0.01. */
  summary(atMs: number): WindowSummary {
    const sec = Math.floor(atMs / 1000);
    const hist = new Uint32Array(BINS);
    const out: WindowSummary = { n: 0, p50: 0, p99: 0, max: 0, rateLimited: 0, worldFull: 0 };
    for (const s of this.slots) {
      if (s.sec > sec || s.sec <= sec - WINDOW_S) continue;
      out.n += s.n; out.rateLimited += s.rateLimited; out.worldFull += s.worldFull;
      if (s.max > out.max) out.max = s.max;
      for (let i = 0; i < BINS; i++) hist[i] += s.hist[i];
    }
    const at = (q: number) => {
      const target = Math.ceil(out.n * q);
      for (let i = 0, seen = 0; i < BINS; i++) if ((seen += hist[i]) >= target) return Math.min(bound(i), out.max);
      return out.max;
    };
    if (out.n) { out.p50 = at(0.5); out.p99 = at(0.99); }
    const r = (v: number) => Math.round(v * 100) / 100;
    return { ...out, p50: r(out.p50), p99: r(out.p99), max: r(out.max) };
  }
}

export type RouteClass = "observe" | "act" | "other";

/** Observe and act are the per-agent hot paths; everything else (spawn, frames, healthz, ...) is "other". */
export function routeClass(method: string, pathname: string): RouteClass {
  if (method === "GET" && /^\/bodies\/[^/]+\/observe$/.test(pathname)) return "observe";
  if (method === "POST" && /^\/bodies\/[^/]+\/act$/.test(pathname)) return "act";
  return "other";
}
