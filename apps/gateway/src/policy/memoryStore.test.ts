import { describe, expect, test } from "bun:test";
import { redis } from "../redis/client";
import { refundToken, resetMemoryStoreForTests, takeToken } from "./memoryStore";

// Keys are unique per run: bun test shares one Redis across all files,
// and a fixed literal bucket would collide with itself between runs.
const uniqueKey = (prefix: string) =>
  `${prefix}:${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("refundToken", () => {
  test("returns a spent token so a failed operation doesn't eat quota", async () => {
    const key = uniqueKey("refund-basic");
    // Refill 0: the balance only moves via take/refund, no time drift.
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(false);

    await refundToken(key, 3, 0);
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(false);
  });

  test("never inflates the bucket past capacity", async () => {
    const key = uniqueKey("refund-cap");
    // Materialize the bucket one token down, then refund twice: the
    // balance must stop at capacity (3), not climb to 4.
    expect(await takeToken(key, 3, 0)).toBe(true);
    await refundToken(key, 3, 0);
    await refundToken(key, 3, 0);
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(true);
    expect(await takeToken(key, 3, 0)).toBe(false);
  });

  test("is a no-op on a missing bucket (an expired spend stays forgotten)", async () => {
    const key = uniqueKey("refund-missing");
    await refundToken(key, 3, 0);
    expect(await redis.exists(key)).toBe(0);
  });
});

describe("resetMemoryStoreForTests", () => {
  test("clears verify-resend buckets", async () => {
    const ownerId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `verify-resend:${ownerId}`;
    // Drain the owner's whole allowance, the state that used to leak
    // across test files because the prefix wasn't in the reset list.
    expect(await takeToken(key, 3, 3 / 3600)).toBe(true);
    expect(await takeToken(key, 3, 3 / 3600)).toBe(true);
    expect(await takeToken(key, 3, 3 / 3600)).toBe(true);
    expect(await takeToken(key, 3, 3 / 3600)).toBe(false);

    await resetMemoryStoreForTests();

    expect(await redis.keys("verify-resend:*")).not.toContain(key);
    expect(await takeToken(key, 3, 3 / 3600)).toBe(true);
  });

  test("clears the owner password buckets", async () => {
    const suffix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const prefixes = ["password-change:", "pwreset-email:", "pwreset-ip:", "pwreset-confirm:"];
    for (const prefix of prefixes) {
      expect(await takeToken(`${prefix}${suffix}`, 3, 3 / 3600)).toBe(true);
      expect(await redis.keys(`${prefix}*`)).toContain(`${prefix}${suffix}`);
    }

    await resetMemoryStoreForTests();

    for (const prefix of prefixes) {
      expect(await redis.keys(`${prefix}*`)).not.toContain(`${prefix}${suffix}`);
    }
  });
});
