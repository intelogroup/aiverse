import { describe, expect, test } from "bun:test";
import { uuidv7 } from "./uuidv7";

describe("uuidv7", () => {
  test("produces RFC 9562 shape: 8-4-4-4-12 hex, version 7, variant 10xx", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("time-ordered: sequential ids never decrease in the timestamp portion", () => {
    const first = uuidv7();
    const later = uuidv7();
    // 48-bit ms = first 8 hex chars + 4 hex chars after the dash (slice(0,12)
    // would run through the "-" and stop early — reassemble instead)
    const tsOf = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(tsOf(later)).toBeGreaterThanOrEqual(tsOf(first));
  });

  test("carries the real wall clock", () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const ts = parseInt(id.slice(0, 8) + id.slice(9, 13), 16); // 48-bit unix ms
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
