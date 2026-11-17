// WI-2 bus subscription reconciliation (extracted from ws/gateway.ts,
// cleanup L2; behavior unchanged).
import {
  AGENT_WILDCARD_SUBJECT,
  FLEET_BROADCAST_SUBJECT,
  FLEET_CONTROL_SUBJECT,
  busMode,
  desiredBusSubjects as busIntentSubjects,
  subscribeBusSubject,
  unsubscribeBusSubject,
} from "./bus";
import { connections, consoleConnections, publicConnections } from "./connections";

// ── WI-2 subscription discipline (PHASE2_SPEC WI-2 step 4) ───────────
// A gateway subscribes to a room subject iff it holds ≥1 socket in that
// room (active or passive — passive sockets still receive mentions and
// digests for the room), to `agent.*` while it holds any agent socket,
// to `fleet.broadcast` while it holds any agent or public socket, and
// to `console.{ownerId}` for each owner with a local console socket.
// fleet.control is subscribed once by startBus and never reconciled
// away. The desired set is recomputed from the WI-3 per-connection
// room sets (and the other registries) — the same source localRoomCount
// reads — by a 1 s reconciler plus immediate pokes from every room-set
// mutation site, so subscribes land promptly while unsubscribes wait
// out a 30 s grace that absorbs reconnect flaps.
const BUS_RECONCILE_INTERVAL_MS = 1_000;

export const BUS_UNSUBSCRIBE_GRACE_MS = 30_000;

const busAbsentSince = new Map<string, number>();

let busReconcilerStarted = false;

export function computeDesiredBusSubjects(): Set<string> {
  const desired = new Set<string>();
  if (connections.size > 0) {
    desired.add(AGENT_WILDCARD_SUBJECT);
    desired.add(FLEET_BROADCAST_SUBJECT);
  }
  if (publicConnections.size > 0) desired.add(FLEET_BROADCAST_SUBJECT);
  for (const conn of connections.values()) {
    for (const roomId of conn.rooms) desired.add(`room.${roomId}`);
  }
  for (const [ownerId, sockets] of consoleConnections) {
    if (sockets.size > 0) desired.add(`console.${ownerId}`);
  }
  return desired;
}

export function reconcileBusSubscriptions(now: number = Date.now()): void {
  if (busMode() === "legacy") return;
  const desired = computeDesiredBusSubjects();
  for (const subject of desired) {
    busAbsentSince.delete(subject);
    subscribeBusSubject(subject);
  }
  for (const subject of busIntentSubjects()) {
    if (subject === FLEET_CONTROL_SUBJECT || desired.has(subject)) continue;
    const since = busAbsentSince.get(subject);
    if (since === undefined) {
      busAbsentSince.set(subject, now);
      continue;
    }
    if (now - since >= BUS_UNSUBSCRIBE_GRACE_MS) {
      unsubscribeBusSubject(subject);
      busAbsentSince.delete(subject);
    }
  }
}

export function pokeBusReconcile(): void {
  reconcileBusSubscriptions();
}

export function startBusSubscriptions(): void {
  if (busReconcilerStarted || busMode() === "legacy") return;
  busReconcilerStarted = true;
  reconcileBusSubscriptions();
  setInterval(() => reconcileBusSubscriptions(), BUS_RECONCILE_INTERVAL_MS);
}
