import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { captureConsolePerf } from "../../lib/telemetry/sentry";
import { deviceClass } from "../../lib/telemetry/context";
import { qualityStore } from "./quality";
import { EventRing, FrameGapDetector, RUM_SAMPLE, loadsInWindow, reportText, shouldSendPerf, summarize, type GapRec, type LoadRec } from "./perfLog";

// PerfProbe + PerfOverlay — the on-device freeze recorder, mounted only with ?perf=1 (see perfLog.ts for why). The probe lives inside the
// Canvas (it reads gl.info and the camera); the overlay is plain DOM. They share this module-level store.

export const perfStore = {
  ring: new EventRing(300),
  loads: [] as LoadRec[],
  live: { rafHz: 0, renderFps: 0, draws: 0, tris: 0, textures: 0, geometries: 0, x: 0, y: 0, z: 0, tier: "" },
  header: "",
  // Field data (RUM): see flushRum. Only filled/used when the probe is mounted with rum.
  rum: false,
  sampled: Math.random() < RUM_SAMPLE,
  sent: false,
  gaps: [] as GapRec[],
  tierChanges: 0,
  ctxLost: 0,
  drawsSamples: [] as number[],
  visibleMs: 0,
  segStart: 0,
};
const SENT_KEY = "aiverse.perf-sent";

/** Whether this page load may report field data: never on the look service's page (?agent), automation, with Do Not Track, ?rum=0, or a build with VITE_PERF_RUM=0. */
export function rumAllowed(agentOn: boolean): boolean {
  if (agentOn) return false;
  try {
    if (new URLSearchParams(window.location.search).get("rum") === "0") return false;
    if ((import.meta.env as Record<string, string | undefined>).VITE_PERF_RUM === "0") return false;
    const nav = navigator as Navigator & { doNotTrack?: string };
    if (navigator.webdriver || nav.doNotTrack === "1" || (window as unknown as { doNotTrack?: string }).doNotTrack === "1") return false;
  } catch { return false; }
  return true;
}

/** Report one summary for this visit (once). Called when the page is hidden or leaves; the SDK transport sends with keepalive. */
function flushRum(): void {
  if (!perfStore.rum || perfStore.sent) return;
  const visibleS = (perfStore.visibleMs + (document.hidden ? 0 : now() - perfStore.segStart)) / 1000;
  let last = 0;
  try { last = Number(window.localStorage.getItem(SENT_KEY)) || 0; } catch { /* storage unavailable: no daily cap, still one per page load */ }
  const wall = Date.now();
  if (!shouldSendPerf({ visibleS, gaps: perfStore.gaps.length, sampled: perfStore.sampled, lastSentMs: last, nowMs: wall })) return;
  const sum = summarize(perfStore.gaps, { visibleS, tierChanges: perfStore.tierChanges, ctxLost: perfStore.ctxLost, drawsSamples: perfStore.drawsSamples });
  const ok = captureConsolePerf(
    { perf_bucket: sum.bucket, perf_device: deviceClass(), perf_tier: perfStore.live.tier || "?", perf_gaps: Math.min(sum.gaps, 99) },
    { ...sum, dpr: window.devicePixelRatio, viewport: `${window.innerWidth}x${window.innerHeight}`, sampled: perfStore.sampled },
  );
  if (ok) {
    perfStore.sent = true;
    try { window.localStorage.setItem(SENT_KEY, String(wall)); } catch { /* ignore */ }
  }
}
const now = () => performance.now();
const note = (kind: "gap" | "tier" | "load" | "ctx" | "vis" | "note", text: string) => perfStore.ring.push({ t: now(), kind, text });
export const perfReport = (): string => reportText(perfStore.header, perfStore.ring.all());

export function PerfProbe({ rum = false }: { rum?: boolean }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    perfStore.header = [
      `UA ${nav.userAgent}`,
      `dpr ${window.devicePixelRatio} viewport ${window.innerWidth}x${window.innerHeight} cores ${nav.hardwareConcurrency ?? "?"} mem ${nav.deviceMemory ?? "?"}GB`,
      `url ${location.pathname}${location.search}  started ${new Date().toISOString()}`,
    ].join("\n");
    perfStore.rum = rum;
    perfStore.segStart = now();
    note("note", `probe on, tier ${qualityStore.getSnapshot().tier}`);

    // Gaps on a plain rAF loop (independent of R3F's frame cap).
    const det = new FrameGapDetector();
    let raf = 0, skipUntil = 0, rafCount = 0, lastSec = now();
    const loop = (t: number) => {
      const hidden = document.hidden || t < skipUntil;
      const gap = det.feed(t, hidden);
      if (gap !== null) {
        const l = perfStore.live;
        const lw = loadsInWindow(perfStore.loads, t - gap - 250, t + 50);
        perfStore.gaps.push({ t, ms: gap, x: l.x, z: l.z, draws: l.draws, tris: l.tris, tier: l.tier, loads: lw });
        if (perfStore.gaps.length > 200) perfStore.gaps.shift();
        // loads first: the panel truncates each line, and "what finished loading" is the most useful part of a gap.
        note("gap", `${Math.round(gap)}ms${lw} | pos ${l.x.toFixed(0)},${l.z.toFixed(0)} y${l.y.toFixed(1)} draws ${l.draws} tris ${(l.tris / 1000).toFixed(0)}k tex ${l.textures} geo ${l.geometries} ${l.tier}`);
      }
      rafCount++;
      if (t - lastSec >= 1000) { perfStore.live.rafHz = Math.round((rafCount * 1000) / (t - lastSec)); rafCount = 0; lastSec = t; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onVis = () => {
      note("vis", document.hidden ? "hidden" : "visible");
      if (document.hidden) { perfStore.visibleMs += now() - perfStore.segStart; flushRum(); }
      else { det.reset(); skipUntil = now() + 1500; perfStore.segStart = now(); }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flushRum);

    const unTier = qualityStore.subscribe(() => { const s = qualityStore.getSnapshot(); perfStore.live.tier = s.tier; perfStore.tierChanges++; note("tier", `${s.tier}: ${s.reason}`); });
    perfStore.live.tier = qualityStore.getSnapshot().tier;

    const el = gl.domElement;
    const onLost = () => { perfStore.ctxLost++; note("ctx", "webgl context LOST"); };
    const onRestored = () => note("ctx", "webgl context restored");
    el.addEventListener("webglcontextlost", onLost);
    el.addEventListener("webglcontextrestored", onRestored);

    // Big asset downloads finishing: parse + GPU upload land right after (Resource Timing works in Safari; cross-origin sizes may read 0).
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          if (!/\.(glb|ktx2|wasm)(\?|$)/.test(e.name)) continue;
          const rec = { end: e.responseEnd, name: e.name.split("/").pop()!.slice(0, 26), bytes: e.encodedBodySize || e.transferSize || 0 };
          perfStore.loads.push(rec); if (perfStore.loads.length > 80) perfStore.loads.shift();
          if (rec.bytes >= 200_000 || e.duration >= 400) note("load", `${rec.name} ${rec.bytes ? (rec.bytes / 1e6).toFixed(2) + "MB " : ""}${Math.round(e.duration)}ms`);
        }
      });
      po.observe({ type: "resource", buffered: true });
    } catch { note("note", "PerformanceObserver(resource) unsupported"); }

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flushRum);
      unTier();
      el.removeEventListener("webglcontextlost", onLost);
      el.removeEventListener("webglcontextrestored", onRestored);
      po?.disconnect();
    };
  }, [gl]);

  // Renderer counters, read where R3F calls us (before this frame's render, so they describe the previous frame).
  let frames = 0, since = now();
  useFrame(() => {
    const i = gl.info, l = perfStore.live;
    l.draws = i.render.calls; l.tris = i.render.triangles; l.textures = i.memory.textures; l.geometries = i.memory.geometries;
    l.x = camera.position.x; l.y = camera.position.y; l.z = camera.position.z;
    frames++;
    if (frames % 30 === 0) { perfStore.drawsSamples.push(l.draws); if (perfStore.drawsSamples.length > 120) perfStore.drawsSamples.shift(); }
    const t = now();
    if (t - since >= 1000) { l.renderFps = Math.round((frames * 1000) / (t - since)); frames = 0; since = t; }
  });
  return null;
}

export function PerfOverlay() {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(true);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { const id = window.setInterval(() => setTick((n) => n + 1), 500); return () => window.clearInterval(id); }, []);

  const copy = async () => {
    const r = perfReport();
    try { await navigator.clipboard.writeText(r); note("note", "report copied"); setText(null); } catch { setText(r); }
  };
  const l = perfStore.live;
  const recent = perfStore.ring.tail(5);
  // Below the app header (about 60 px + the notch), narrow enough to leave the right-hand Share / Full view column free, one line per event, and click-through except the buttons: the first live
  // look (2026-11-22, 390 px phone) showed the old panel covering the header's Live / Search / Share / Full view controls.
  const box: React.CSSProperties = { position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 68px)", left: 6, zIndex: 99999, width: "min(64vw, 300px)", font: "9px/1.25 ui-monospace, Menlo, monospace", color: "#b6ffb6", background: "rgba(0,0,0,0.68)", padding: "3px 5px", borderRadius: 4, pointerEvents: "none" };
  const btn: React.CSSProperties = { pointerEvents: "auto", font: "inherit", color: "#fff", background: "#234", border: "1px solid #567", borderRadius: 3, padding: "2px 6px", marginRight: 4 };
  if (!open) return <div style={box}><button style={btn} onClick={() => setOpen(true)}>perf</button></div>;
  return (
    <div style={box}>
      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>raf {l.rafHz}Hz · render {l.renderFps}fps · draws {l.draws} · tris {(l.tris / 1000).toFixed(0)}k · tex {l.textures} · geo {l.geometries} · {l.tier}</div>
      <div style={{ margin: "2px 0" }}>{recent.map((e, i) => <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{`${(e.t / 1000).toFixed(1)}s ${e.kind} ${e.text}`}</div>)}</div>
      <button style={btn} onClick={copy}>Copy log</button>
      <button style={btn} onClick={() => setText(perfReport())}>Show</button>
      <button style={btn} onClick={() => { perfStore.ring.clear(); setText(null); }}>Clear</button>
      <button style={btn} onClick={() => setOpen(false)}>Hide</button>
      {text !== null ? <textarea readOnly value={text} style={{ pointerEvents: "auto", display: "block", width: "88vw", height: "30vh", marginTop: 4, font: "inherit" }} onFocus={(e) => e.currentTarget.select()} /> : null}
    </div>
  );
}
