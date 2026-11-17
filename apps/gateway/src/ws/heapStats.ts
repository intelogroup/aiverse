// Heap budget stats (extracted from ws/gateway.ts, cleanup L2; behavior
// unchanged).
import { connections } from "./connections";

export const HEAP_STATS_INTERVAL_MS = 60_000;

export function formatHeapStatsLine(
  mem: { rss: number; heapUsed: number; heapTotal: number },
  conns: number,
  roomsLocal: number,
): string {
  const mb = (bytes: number) => Math.floor(bytes / 1_048_576);
  return `heap rss_mb=${mb(mem.rss)} heap_used_mb=${mb(mem.heapUsed)} heap_total_mb=${mb(mem.heapTotal)} conns=${conns} rooms_local=${roomsLocal}`;
}

// Distinct rooms with >= 1 local socket, from the per-connection room sets.
export function localRoomCount(): number {
  const rooms = new Set<string>();
  for (const conn of connections.values()) {
    for (const roomId of conn.rooms) rooms.add(roomId);
  }
  return rooms.size;
}

export function heapStatsLine(): string {
  return formatHeapStatsLine(process.memoryUsage(), connections.size, localRoomCount());
}

let heapStatsTimerStarted = false;

// Called once from index.ts at boot — heap is a per-process budget, so
// both leader and follower emit it (unlike the singleton jobs). The
// module-singleton guard keeps repeated calls from double-starting the
// timer, same pattern as the presence-digest flusher above.
export function scheduleHeapStats(): void {
  if (heapStatsTimerStarted) return;
  heapStatsTimerStarted = true;
  setInterval(() => {
    console.log(heapStatsLine());
  }, HEAP_STATS_INTERVAL_MS);
}
