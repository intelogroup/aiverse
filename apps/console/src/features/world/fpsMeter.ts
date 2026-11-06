// fpsMeter.ts — a tiny rolling frames-per-second meter.
//
// The Embody panel shows a live render-fps readout while a bot camera
// mode (Follow / Ride) is active, so a clip test on Summer can be
// judged against the frame rate it actually renders at. The tracker
// component in GlbWorld.tsx pushes one timestamp per rendered frame;
// the panel reads the average over the trailing window (~0.5 s).
//
// Pure logic, three-free and DOM-free, same discipline as cameraRig.ts:
// timestamps are plain millisecond numbers from any clock the caller
// owns (performance.now in the browser).

/** Trailing window the rate is averaged over, ms. */
export const FPS_WINDOW_MS = 500;

/** How long stamps are retained, ms — two windows, so the rate can
 * always be computed across a full window right up to the newest stamp. */
const RETAIN_MS = FPS_WINDOW_MS * 2;

export class FpsMeter {
  private stamps: number[] = [];

  /** Record one rendered frame at timestamp `tMs` (monotonic). */
  push(tMs: number): void {
    this.stamps.push(tMs);
    const cut = tMs - RETAIN_MS;
    let drop = 0;
    while (drop < this.stamps.length && this.stamps[drop] < cut) drop++;
    if (drop > 0) this.stamps.splice(0, drop);
  }

  /**
   * Frames per second averaged over the trailing FPS_WINDOW_MS ending
   * at the newest stamp: the intervals between the stamps inside the
   * window, so a steady 60 fps stream reads 60 (not 61 from counting
   * both endpoints). 0 until two stamps share the window.
   */
  fps(): number {
    const n = this.stamps.length;
    if (n < 2) return 0;
    const last = this.stamps[n - 1];
    const from = last - FPS_WINDOW_MS;
    let first = n - 1;
    while (first > 0 && this.stamps[first - 1] >= from) first--;
    const count = n - first;
    const spanMs = last - this.stamps[first];
    if (count < 2 || spanMs <= 0) return 0;
    return ((count - 1) / spanMs) * 1000;
  }

  reset(): void {
    this.stamps = [];
  }
}
