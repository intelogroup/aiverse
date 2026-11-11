import { useEffect } from "react";
import { SUBSCRIBE_WORLD, WORLD_FRAMES, WORLD_ROSTER, WORLD_SAY } from "@aiverse/world-sim/streamProtocol";
import type { RemoteBodies } from "./remoteFrames";

/**
 * Open the public feed, ask for the world, and pour the pose stream into `bodies`. Reconnects with backoff; while disconnected the
 * figures are removed (a frozen ghost is worse than an empty street). The socket is separate from usePublicWs on purpose: pages that
 * only want public messages never receive (or parse) pose frames.
 */
export function useWorldStream(enabled: boolean, bodies: RemoteBodies): void {
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let delay = 1000;
    let closed = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/api`;

    const connect = () => {
      ws = new WebSocket(`${base}/public/ws`);
      ws.onopen = () => { delay = 1000; ws?.send(JSON.stringify({ type: SUBSCRIBE_WORLD })); };
      ws.onmessage = (e) => {
        let m: { type?: string; payload?: unknown };
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.type === WORLD_FRAMES) bodies.applyFrames(m.payload as never, performance.now() / 1000);
        else if (m.type === WORLD_ROSTER) bodies.applyRoster(m.payload as never);
        else if (m.type === WORLD_SAY) bodies.applySay(m.payload as never, performance.now());
      };
      ws.onclose = () => {
        bodies.clear();
        if (closed) return;
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15_000);
      };
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); ws?.close(); bodies.clear(); };
  }, [enabled, bodies]);
}
