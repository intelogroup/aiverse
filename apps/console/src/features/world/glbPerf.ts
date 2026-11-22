// Touch-path performance drivers: the render-rate tracker, the
// quality governor driver and the fps cap (extracted from
// GlbWorld.tsx, cleanup L2).
import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { FpsMeter } from "./fpsMeter";
import { FrameThrottle, QualityGovernor, TOUCH_FPS_CAP, governorSampleFps, qualityStore } from "./quality";

/**
 * Render-rate tracker: one timestamp per rendered frame into the
 * shared FpsMeter (fpsMeter.ts), which the touch QualityDriver reads
 * to govern the quality tier. Mounted on the touch path — the meter
 * costs one array push per frame.
 */
export function FpsTracker({ meterRef }: { meterRef: RefObject<FpsMeter | null> }) {
  useFrame((state) => {
    meterRef.current?.push(state.clock.elapsedTime * 1000);
  });
  return null;
}

/**
 * Mobile Phase 3: the quality governor's driver. Once a second it
 * feeds the FpsMeter's rolling rate to a QualityGovernor and lands
 * verdicts on the shared quality store (which the Canvas props and
 * the You sheet read). Mounted on the touch path only — desktop
 * quality never moves.
 */
export function QualityDriver({ meterRef }: { meterRef: RefObject<FpsMeter | null> }) {
  const governor = useRef<QualityGovernor | null>(null);
  if (governor.current === null) governor.current = new QualityGovernor("reduced");
  const acc = useRef(0);
  // Big downloads finishing (Resource Timing works in Safari): their parse/upload hitch is not the device being slow.
  useEffect(() => {
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (/\.(glb|ktx2|wasm)(\?|$)/.test(e.name)) governor.current?.noteLoad(performance.now());
      });
      po.observe({ type: "resource" });
    } catch { /* unsupported: the warmup and hold times still apply */ }
    return () => po?.disconnect();
  }, []);
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 1) return;
    acc.current = 0;
    const meter = meterRef.current;
    if (!meter) return;
    // The touch render cap (TouchFpsCap) bounds the meter's read at
    // TOUCH_FPS_CAP; governorSampleFps keeps "holding the cap" out of
    // the step-down band so the governor never fights the cap.
    const verdict = governor.current?.sample(governorSampleFps(meter.fps()), performance.now());
    if (verdict) qualityStore.govern(verdict);
  });
  return null;
}

/**
 * Thermal guardrail (2026-11-12): the touch path's render-rate cap.
 * Switches the Canvas to demand rendering and pumps invalidate() at
 * TOUCH_FPS_CAP — a phone holding a 3D world at full refresh cooks
 * itself into throttling within minutes; 30 fps is the rate the
 * quality governor already treats as the touch floor, so the cap and
 * the ladder agree. Mounted on the human touch path only: agent mode
 * already runs demand (ScoutAgent pumps its own frames), and desktop
 * keeps its uncapped "always" loop. Restores "always" on unmount.
 */
export function TouchFpsCap() {
  const set = useThree((s) => s.set);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    set({ frameloop: "demand" });
    const throttle = new FrameThrottle(TOUCH_FPS_CAP);
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (throttle.shouldRender(t)) invalidate();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      set({ frameloop: "always" });
    };
  }, [set, invalidate]);
  return null;
}
