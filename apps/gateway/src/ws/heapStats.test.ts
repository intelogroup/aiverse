import { describe, expect, test } from "bun:test";
import { formatHeapStatsLine, heapStatsLine, localRoomCount } from "./gateway";

// PHASE2_SPEC WI-6 test (a): the TS heap line and the Go edge's line share
// one key=value shape so soak tooling parses both stacks with one format.
// The Go line is `heap inuse_mb= alloc_mb= sys_mb= gc_count=
// last_gc_pause_ms= conns=` (its runtime.MemStats vocabulary); the TS keys
// are the spec's Bun process.memoryUsage() vocabulary below, in the same
// `heap k=v ...` shape with the same whole-MB integer style.
const HEAP_LINE_RE = /^heap rss_mb=\d+ heap_used_mb=\d+ heap_total_mb=\d+ conns=\d+ rooms_local=\d+$/;

const MB = 1_048_576;

describe("formatHeapStatsLine (P2 WI-6)", () => {
  test("emits exactly the spec keys, in order, in the shared shape", () => {
    const line = formatHeapStatsLine({ rss: 120 * MB, heapUsed: 80 * MB, heapTotal: 95 * MB }, 42, 7);
    expect(line).toBe("heap rss_mb=120 heap_used_mb=80 heap_total_mb=95 conns=42 rooms_local=7");
    expect(line).toMatch(HEAP_LINE_RE);
  });

  test("MB values floor to whole MB (the Go line's >>20 integer style)", () => {
    const line = formatHeapStatsLine(
      { rss: 2.9 * MB, heapUsed: 1.5 * MB, heapTotal: MB - 1 },
      3,
      1,
    );
    expect(line).toBe("heap rss_mb=2 heap_used_mb=1 heap_total_mb=0 conns=3 rooms_local=1");
  });

  test("zero memory and zero connections", () => {
    const line = formatHeapStatsLine({ rss: 0, heapUsed: 0, heapTotal: 0 }, 0, 0);
    expect(line).toBe("heap rss_mb=0 heap_used_mb=0 heap_total_mb=0 conns=0 rooms_local=0");
    expect(line).toMatch(HEAP_LINE_RE);
  });

  test("the live snapshot line parses, against this process's empty registry", () => {
    // Bun runs each test file in its own process, and this file opens no
    // sockets: the registry counts must read zero, and the memory fields
    // must be real positive values from process.memoryUsage().
    expect(localRoomCount()).toBe(0);
    const line = heapStatsLine();
    expect(line).toMatch(HEAP_LINE_RE);
    expect(line.endsWith("conns=0 rooms_local=0")).toBe(true);
    expect(line).not.toContain("rss_mb=0");
  });
});
