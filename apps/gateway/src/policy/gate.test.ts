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

  // Regression for AIV-BUDGET-FRACTIONAL-001 (adversarial loop cycle
  // 2026-11-01-1407): the third leg of the amount discipline. A fractional
  // tokensUsed passed the sign/finiteness checks above and threw inside
  // the integer-only INCRBY — a 500 for the sender instead of a refusal.
  test("a fractional consume is refused as invalid_amount and the ledger stays exactly enforceable", async () => {
    const legit = await checkAndConsumeBudget("agent-frac", 300, 1000, "2026-01-01");
    expect(legit.allowed).toBe(true);
    expect(legit.tokensUsedToday).toBe(300);

    const frac = await checkAndConsumeBudget("agent-frac", 1.5, 1000, "2026-01-01");
    expect(frac.allowed).toBe(false);
    expect(frac.reason).toBe("invalid_amount");
    expect(frac.tokensUsedToday).toBe(300);

    // Not poisoned: the remaining integer budget is enforced to the token.
    const fill = await checkAndConsumeBudget("agent-frac", 700, 1000, "2026-01-01");
    expect(fill.allowed).toBe(true);
    expect(fill.tokensUsedToday).toBe(1000);
    const over = await checkAndConsumeBudget("agent-frac", 1, 1000, "2026-01-01");
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe("budget_exceeded");
  });

  test("concurrent fractional consumes racing legitimate spends never over-admit and settle exactly", async () => {
    const calls = [
      ...Array.from({ length: 5 }, () => checkAndConsumeBudget("agent-frac-race", 0.5, 1000, "2026-01-01")),
      ...Array.from({ length: 3 }, () => checkAndConsumeBudget("agent-frac-race", 400, 1000, "2026-01-01")),
    ];
    // Promise.all rejects if ANY call throws — a throw is itself a failure.
    const results = await Promise.all(calls);
    for (const r of results.slice(0, 5)) {
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe("invalid_amount");
    }
    const posWinners = results.slice(5).filter((r) => r.allowed).length;
    expect(posWinners).toBe(2); // 2*400=800 <= 1000; the third would reach 1200
    const probe = await checkAndConsumeBudget("agent-frac-race", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(800);
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

  // AIV-BUDGET-FRACTIONAL-001, refund leg: the refund paths in
  // conversations/a2a hand refundBudget the same untrusted tokensUsed as
  // the consume, so a fractional refund gets the same discipline — it
  // must not move the counter or leave a fractional value behind that
  // poisons later integer spends.
  test("a fractional refund does not move the counter or poison it", async () => {
    await checkAndConsumeBudget("agent-refund-frac", 300, 1000, "2026-01-01");
    await refundBudget("agent-refund-frac", 1.5, "2026-01-01");
    const probe = await checkAndConsumeBudget("agent-refund-frac", 0, 1000, "2026-01-01");
    expect(probe.tokensUsedToday).toBe(300);
    // Still a clean integer ledger: an exact fill is admitted afterwards.
    const fill = await checkAndConsumeBudget("agent-refund-frac", 700, 1000, "2026-01-01");
    expect(fill.allowed).toBe(true);
    expect(fill.tokensUsedToday).toBe(1000);
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
