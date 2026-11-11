// The viewer stream's gateway half: pull the sim's poses, turn them into key/delta frames, and push them to the spectators that
// asked for the world (`{type:"subscribe_world"}` on /public/ws).
//
// Design choices (see the M5 plan):
//  * Every gateway instance pulls from the sim itself and sends to its OWN sockets. No Redis hop, no leader coupling; the sim sees
//    one cheap GET per instance per tick, and only while somebody is watching (the loop stops at zero subscribers).
//  * Spectators are anonymous and public: they get a display name and a body model per body number, never an agent id or owner.
//  * Poses are latest-wins, so a slow socket simply misses frames (checked via its buffered amount) instead of queueing them.
import { envelope } from "../ws/events";
import { FrameDiffer, WORLD_FRAMES, WORLD_ROSTER, WORLD_SAY, type FramesMessage, type PoseTuple, type RosterMessage, type SayMessage } from "@aiverse/world-sim/streamProtocol";
import type { SimClient } from "./simClient";

export interface StreamSocket {
  send(data: string): void;
  /** Bun's ServerWebSocket exposes this; absent in tests. */
  getBufferedAmount?(): number;
}

export interface WorldStreamOpts {
  sim: SimClient;
  /** agent id -> display name. Called only when the roster changes. */
  names: (agentIds: string[]) => Promise<Map<string, string>>;
  intervalMs?: number;
  keyEveryMs?: number;
  maxSubscribers?: number;
  /** A socket with more than this many bytes queued misses the frame. */
  maxBufferedBytes?: number;
  now?: () => number;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

interface SimFrames { epoch: string; t: number; rosterRev: number; b: PoseTuple[]; say?: SayMessage["say"] }
interface SimRoster { epoch: string; rev: number; bodies: { n: number; agentId: string; body: string }[] }

export function createWorldStream(opts: WorldStreamOpts) {
  const interval = opts.intervalMs ?? 150;
  const maxSubs = opts.maxSubscribers ?? 2000;
  const maxBuffered = opts.maxBufferedBytes ?? 64 * 1024;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const subs = new Map<unknown, StreamSocket>();
  const differ = new FrameDiffer(opts.keyEveryMs ?? 2000);
  let roster: RosterMessage | null = null;
  let rosterRev = -1;
  let saidEpoch = "";
  let saidSeq = 0;
  let lastT = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const stats = { cycles: 0, framesSent: 0, bytesSent: 0, dropped: 0 };

  const wire = (type: string, payload: unknown) => JSON.stringify(envelope(type, payload));

  function push(sock: StreamSocket, key: unknown, text: string): void {
    try {
      if ((sock.getBufferedAmount?.() ?? 0) > maxBuffered) { stats.dropped++; return; }
      sock.send(text);
      stats.framesSent++;
      stats.bytesSent += text.length;
    } catch {
      subs.delete(key); // a dead socket must not stall the others
    }
  }
  const broadcast = (text: string) => { for (const [k, s] of subs) push(s, k, text); };

  async function refreshRoster(epoch: string): Promise<void> {
    const res = await opts.sim.call("GET", "/roster");
    if (!res.ok) return;
    const r = (await res.json()) as SimRoster;
    const names = await opts.names(r.bodies.map((b) => b.agentId)).catch(() => new Map<string, string>());
    roster = { epoch, bodies: r.bodies.map((b) => ({ n: b.n, name: names.get(b.agentId) ?? "agent", body: b.body })) };
    rosterRev = r.rev;
    broadcast(wire(WORLD_ROSTER, roster));
  }

  async function cycle(): Promise<void> {
    stats.cycles++;
    const res = await opts.sim.call("GET", "/frames");
    if (!res.ok) throw new Error(`sim /frames ${res.status}`);
    const f = (await res.json()) as SimFrames;
    if (f.rosterRev !== rosterRev || roster?.epoch !== f.epoch) await refreshRoster(f.epoch);
    lastT = f.t;
    const msg = differ.next(f.epoch, f.t, f.b, now());
    if (msg.b.length || msg.gone.length || msg.key) broadcast(wire(WORLD_FRAMES, msg));
    // Speech rides its own message: it must reach spectators even when no pose changed. The sim keeps a line for a few seconds,
    // so each is sent once, the first cycle that shows a sequence number we have not sent.
    if (f.epoch !== saidEpoch) { saidEpoch = f.epoch; saidSeq = 0; }
    const fresh = (f.say ?? []).filter((e) => e.seq > saidSeq);
    if (fresh.length) {
      saidSeq = Math.max(...fresh.map((e) => e.seq));
      broadcast(wire(WORLD_SAY, { epoch: f.epoch, say: fresh.map((e) => ({ seq: e.seq, n: e.n, text: String(e.text).slice(0, 140) })) } satisfies SayMessage));
    }
  }

  async function loop(): Promise<void> {
    timer = null;
    if (!subs.size) { running = false; return; }
    let delay = interval;
    try {
      await cycle();
      failures = 0;
    } catch (e) {
      failures++;
      delay = Math.min(5000, interval * 2 ** Math.min(failures, 6));
      // The sim is gone or sick: after a few misses tell viewers the world is empty rather than leaving frozen figures standing.
      if (failures === 3) {
        log("world_stream_sim_down", { error: e instanceof Error ? e.message : String(e) });
        differ.reset();
        roster = null;
        rosterRev = -1;
        const cleared: FramesMessage = { epoch: "", t: lastT, key: true, b: [], gone: [] };
        broadcast(wire(WORLD_FRAMES, cleared));
      }
    }
    if (subs.size) timer = setTimeout(loop, delay);
    else running = false;
  }

  function start(): void {
    if (running) return;
    running = true;
    timer = setTimeout(loop, 0);
  }

  return {
    /** A spectator asked for the world. Returns false when full. It gets the current roster and picture at once. */
    subscribe(key: unknown, sock: StreamSocket): boolean {
      if (!subs.has(key) && subs.size >= maxSubs) return false;
      subs.set(key, sock);
      if (roster) push(sock, key, wire(WORLD_ROSTER, roster));
      const full = differ.full(lastT);
      if (full) push(sock, key, wire(WORLD_FRAMES, full));
      start();
      return true;
    },
    unsubscribe(key: unknown): void {
      subs.delete(key);
    },
    get subscribers(): number { return subs.size; },
    get running(): boolean { return running; },
    stats: () => ({ ...stats }),
    /** For tests and shutdown. */
    stop(): void {
      subs.clear();
      if (timer) clearTimeout(timer);
      timer = null;
      running = false;
    },
  };
}

export type WorldStream = ReturnType<typeof createWorldStream>;

// A registry like world/hooks.ts, so ws/gateway.ts can reach the stream without importing the app wiring.
let current: WorldStream | null = null;
export const setWorldStream = (s: WorldStream | null): void => { current?.stop(); current = s; };
export const getWorldStream = (): WorldStream | null => current;
