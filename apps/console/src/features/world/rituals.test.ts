import { describe, expect, it } from "vitest";
import { clock, ritualAt } from "./rituals";

const at = (min: number, sec = 0) => Date.UTC(2026, 0, 1, 5, min, sec);
describe("rituals", () => {
  it("is active inside a window and counts down to its end", () => {
    const s = ritualAt(at(0, 30));
    expect(s).toMatchObject({ active: true, seconds: 150 });
    expect(s.ritual.id).toBe("fountain");
  });
  it("points at the next ritual between windows", () => {
    const s = ritualAt(at(10));
    expect(s.active).toBe(false);
    expect(s.ritual.id).toBe("openmic");
    expect(s.seconds).toBe(600);
  });
  it("wraps past the last window to the next hour", () => {
    const s = ritualAt(at(50));
    expect(s.ritual.id).toBe("fountain");
    expect(s.seconds).toBe(600);
  });
  it("formats the countdown", () => expect(clock(65)).toBe("1:05"));
});
