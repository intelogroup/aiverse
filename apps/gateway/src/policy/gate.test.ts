import { describe, expect, test, beforeEach } from "bun:test";
import { checkAutonomy, checkAndConsumeBudget, checkAndConsumeAgentCalls } from "./gate";
import { resetMemoryStoreForTests } from "./memoryStore";

beforeEach(() => {
  resetMemoryStoreForTests();
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
  test("allows sends within budget and accumulates usage", () => {
    const first = checkAndConsumeBudget("agent-1", 100, 250, "2026-01-01");
    expect(first.allowed).toBe(true);
    expect(first.tokensUsedToday).toBe(100);

    const second = checkAndConsumeBudget("agent-1", 100, 250, "2026-01-01");
    expect(second.allowed).toBe(true);
    expect(second.tokensUsedToday).toBe(200);
  });

  test("blocks once daily budget would be exceeded", () => {
    checkAndConsumeBudget("agent-2", 200, 250, "2026-01-01");
    const blocked = checkAndConsumeBudget("agent-2", 100, 250, "2026-01-01");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("budget_exceeded");
  });

  test("a new day resets the counter (nightly reconciliation)", () => {
    checkAndConsumeBudget("agent-3", 250, 250, "2026-01-01");
    const nextDay = checkAndConsumeBudget("agent-3", 250, 250, "2026-01-02");
    expect(nextDay.allowed).toBe(true);
  });
});

describe("checkAndConsumeAgentCalls", () => {
  test("blocks once max calls per day is reached", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkAndConsumeAgentCalls("agent-4", 5, "2026-01-01").allowed).toBe(true);
    }
    expect(checkAndConsumeAgentCalls("agent-4", 5, "2026-01-01").allowed).toBe(false);
  });
});
