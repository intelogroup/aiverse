import { describe, expect, test } from "vitest";
import { APPLE_PICKUP, APPLE_RECEIVING, APPLE_STANDS } from "@aiverse/world-sim/movableProps";
import { appleMotion, appleVisual } from "./appleGrip";

describe("remote apple", () => {
  test("renders the transfer on the delayed view clock, not on packet arrival", () => {
    const pickup = { stand: APPLE_PICKUP, holder: 9, motion: { stand: APPLE_PICKUP, n: 9, startedAt: 10 } };
    expect(appleVisual(pickup, 12).holder).toBeNull();
    expect(appleVisual(pickup, 10 + APPLE_STANDS[APPLE_PICKUP].contact).holder).toBe(9);
    const put = { stand: APPLE_RECEIVING, holder: null, motion: { stand: APPLE_RECEIVING, n: 9, startedAt: 30 } };
    expect(appleVisual(put, 34).holder).toBe(9);
    expect(appleVisual(put, 36)).toEqual({ stand: APPLE_RECEIVING, holder: null });
  });

  test("uses the calibrated local clock and grounding for the owning body only", () => {
    const frame = { stand: APPLE_PICKUP, holder: null, motion: { stand: APPLE_PICKUP, n: 9, startedAt: 10 } };
    expect(appleMotion(frame, 8, 12)).toBeNull();
    expect(appleMotion(frame, 9, 9)).toBeNull();
    expect(appleMotion(frame, 9, 12)).toMatchObject({ clip: "PickUp", time: 2 });
    expect(Number.isFinite(appleMotion(frame, 9, 12)?.ground)).toBe(true);
  });
});
