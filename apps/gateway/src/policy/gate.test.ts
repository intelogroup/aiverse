import { describe, expect, test, beforeEach } from "bun:test";
import { checkAutonomy, checkAndConsumeBudget, checkAndConsumeAgentCalls, refundBudget } from "./gate";
import { resetMemoryStoreForTests } from "./memoryStore";

beforeEach(async () => {
  await resetMemoryStoreForTests();
});

describe("checkAutonomy", () => {
  test("observe mode blocks all outbound sends", () => {
    expect(checkAutonomy("observe", 0)).toEqual({
      allowed: false,
      reason: "autonomy_observe_blocks_send",
    });
  });

  test("assist mode allows but flags approval when spend is touched", () => {
    const result = checkAutonomy("assist", 500);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  test("assist mode with no spend does not require approval", () => {
    const result = checkAutonomy("assist", 0);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBeUndefined();
  });

  test("autonomous mode never requires approval", () => {
    const result = checkAutonomy("autonomous", 999);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBeUndefined();
  });
});

describe("checkAndConsumeBudget", () => {
  test("allows sends within budget and accumulates usage", async () => {
    const first = await checkAndConsumeBudget("agent-1", 100, 250, "2026-01-01");
    expect(first.allowed).toBe(true);
    expect(first.tokensUsedToday).toBe(100);

    const second = await checkAndConsumeBudget("agent-1", 100, 250, "2026-01-01");
    expect(second.allowed).toBe(true);
    expect(second.tokensUsedToday).toBe(200);
  });

  test("blocks once daily budget would be exceeded", async () => {
    await checkAndConsumeBudget("agent-2", 200, 250, "2026-01-01");
    const blocked = await checkAndConsumeBudget("agent-2", 100, 250, "2026-01-01");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("budget_exceeded");
  });

  test("a new day resets the counter (nightly reconciliation)", async () => {
    await checkAndConsumeBudget("agent-3", 250, 250, "2026-01-01");
    const nextDay = await checkAndConsumeBudget("agent-3", 250, 250, "2026-01-02");
    expect(nextDay.allowed).toBe(true);
  });

  // Regression for AIV-BUDGET-NEGATIVE-001 (adversarial loop cycle
  // 2026-11-01-0807): the amount here is client-reported usage, and a
  // negative "spend" used to sail through the limit check and pull the
  // counter below zero — minting budget headroom out of recorded usage.
  test("a negative consume is refused and never reduces the counter or mints headroom", async () => {
    const legit = await checkAndConsumeBudget("agent-neg", 300, 1000, "2026-01-01");
    expect(legit.allowed).toBe(true);
    expect(legit.tokensUsedToday).toBe(300);

    const neg = await checkAndConsumeBudget("agent-neg", -1000, 1000, "2026-01-01");
    expect(neg.allowed).toBe(false);
    expect(neg.reason).toBe("invalid_amount");
    expect(neg.tokensUsedToday).toBe(300);

    // No minted headroom: 300 + 800 > 1000 must still be denied, and the
    // recorded total must be exactly where the legitimate spend left it.
    const over = await checkAndConsumeBudget("agent-neg", 800, 1000, "2026-01-01");
    expect(over.allowed).toBe(false);
    const probe = await checkAndConsumeBudget("agent-neg", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(300);
  });

  test("concurrent negative consumes racing legitimate spends never over-admit or erase recorded spend", async () => {
    const calls = [
      ...Array.from({ length: 5 }, () => checkAndConsumeBudget("agent-race", -200, 1000, "2026-01-01")),
      ...Array.from({ length: 3 }, () => checkAndConsumeBudget("agent-race", 400, 1000, "2026-01-01")),
    ];
    const results = await Promise.all(calls);
    const posWinners = results.slice(5).filter((r) => r.allowed).length;

    const probe = await checkAndConsumeBudget("agent-race", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(posWinners * 400);
    expect(probe.tokensUsedToday).toBeLessThanOrEqual(1000);
  });

  test("a non-finite consume is refused and leaves the counter untouched", async () => {
    await checkAndConsumeBudget("agent-nan", 300, 1000, "2026-01-01");
    const nan = await checkAndConsumeBudget("agent-nan", Number.NaN, 1000, "2026-01-01");
    expect(nan.allowed).toBe(false);
    const probe = await checkAndConsumeBudget("agent-nan", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(300);
  });
});

describe("refundBudget", () => {
  test("an oversized refund floors the counter at zero instead of minting headroom", async () => {
    await checkAndConsumeBudget("agent-refund", 300, 1000, "2026-01-01");
    await refundBudget("agent-refund", 1000, "2026-01-01");
    const probe = await checkAndConsumeBudget("agent-refund", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(0);
    // The floored counter still enforces the real budget afterwards.
    const spend = await checkAndConsumeBudget("agent-refund", 1000, 1000, "2026-01-01");
    expect(spend.allowed).toBe(true);
  });

  test("a negative refund does not inflate the counter", async () => {
    await checkAndConsumeBudget("agent-refund-neg", 300, 1000, "2026-01-01");
    await refundBudget("agent-refund-neg", -500, "2026-01-01");
    const probe = await checkAndConsumeBudget("agent-refund-neg", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(300);
  });
});

describe("checkAndConsumeAgentCalls", () => {
  test("blocks once max calls per day is reached", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await checkAndConsumeAgentCalls("agent-4", 5, "2026-01-01")).allowed).toBe(true);
    }
    expect((await checkAndConsumeAgentCalls("agent-4", 5, "2026-01-01")).allowed).toBe(false);
  });
});
