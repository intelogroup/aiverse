import { describe, test, expect } from "bun:test";
import {
  busMode,
  subjectForFanout,
  newMid,
  MidDedupe,
  FLEET_BROADCAST_SUBJECT,
  FLEET_CONTROL_SUBJECT,
} from "./bus";

// PHASE2_SPEC WI-2 unit coverage for the bus module's pure pieces:
// mode parsing (legacy is the default and the fallback), the subject
// design (step 1), the mid format (uuidv7), and the dual-run dedupe
// ring. The transport behaviors (publish counts, non-delivery, dual
// exactly-once, rollback, cross-edge) are integration-proven by the
// local fleet harness, not here — this file never opens a connection:
// importing bus.ts is inert until startBus is called, and no test here
// calls it.

describe("busMode", () => {
  const KEY = "AIVERSE_BUS_MODE";
  function withMode<T>(v: string | undefined, fn: () => T): T {
    const prev = process.env[KEY];
    if (v === undefined) delete process.env[KEY];
    else process.env[KEY] = v;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  test("unset is legacy (the default — prod deploys dark)", () => {
    withMode(undefined, () => expect(busMode()).toBe("legacy"));
  });
  test("dual and nats parse", () => {
    withMode("dual", () => expect(busMode()).toBe("dual"));
    withMode("nats", () => expect(busMode()).toBe("nats"));
  });
  test("anything else falls back to legacy", () => {
    withMode("NATS", () => expect(busMode()).toBe("legacy"));
    withMode("redis", () => expect(busMode()).toBe("legacy"));
    withMode("", () => expect(busMode()).toBe("legacy"));
  });
});

describe("subjectForFanout (WI-2 step 1 subject design)", () => {
  test("direct agent traffic is agent-scoped", () => {
    expect(subjectForFanout({ kind: "agent", agentId: "a-1" })).toBe("agent.a-1");
  });
  test("room-scoped broadcast is room-scoped", () => {
    expect(subjectForFanout({ kind: "broadcast", roomConversationId: "c-9" })).toBe("room.c-9");
  });
  test("unscoped broadcast and public events are fleet-global", () => {
    expect(subjectForFanout({ kind: "broadcast" })).toBe(FLEET_BROADCAST_SUBJECT);
    expect(subjectForFanout({ kind: "public" })).toBe(FLEET_BROADCAST_SUBJECT);
  });
  test("console pushes are owner-scoped", () => {
    expect(subjectForFanout({ kind: "console", ownerId: "o-7" })).toBe("console.o-7");
  });
  test("fleet.control is its own subject", () => {
    expect(FLEET_CONTROL_SUBJECT).toBe("fleet.control");
  });
});

describe("newMid", () => {
  test("is a uuidv7 (version 7, RFC variant, time-ordered shape)", () => {
    const mid = newMid();
    expect(mid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test("successive mids differ", () => {
    expect(newMid()).not.toBe(newMid());
  });
});

describe("MidDedupe (dual-run exactly-once)", () => {
  test("first sight passes, second sight is a duplicate", () => {
    const d = new MidDedupe();
    expect(d.check("m-1")).toBe(false);
    expect(d.check("m-1")).toBe(true);
    expect(d.check("m-2")).toBe(false);
    expect(d.check("m-1")).toBe(true);
  });
  test("empty mid never dedupes (pre-WI-2 envelopes carry none)", () => {
    const d = new MidDedupe();
    expect(d.check("")).toBe(false);
    expect(d.check("")).toBe(false);
  });
  test("the ring is bounded: an evicted mid passes again", () => {
    const d = new MidDedupe();
    expect(d.check("old")).toBe(false);
    // Fill past capacity (256) with distinct mids; "old" falls out.
    for (let i = 0; i < 300; i++) d.check(`filler-${i}`);
    expect(d.check("old")).toBe(false);
    // ...while a recent mid is still remembered.
    expect(d.check("filler-299")).toBe(true);
  });
});
