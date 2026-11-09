// Schema validation for wallet PATCH bodies (AIV-WALLET-HOSTILE-CEILING-001).
//
// Both write paths to agent_wallets — owner (routes/owners.ts) and admin
// (routes/admin.ts) — used to pass the raw parsed JSON body into
// db.update().set(body). TypeScript annotations are compile-time only, so
// at runtime negative, fractional, string-typed, or absurd values for the
// ceiling fields were written verbatim or 500'd the request. These fields
// ARE the control that gates agent spend; validate them like it. The
// pattern mirrors the mandate validator in routes/owners.ts.
//
// Rules per numeric field: must be a finite number, 0 <= v <= int4 max
// (larger values 500 at the Postgres driver — reject as a client error
// instead), fractional values floored (same convention as the policy
// handler's maxParallelDelegations). autonomyMode must be one of the enum
// values. Unknown keys are dropped, never written. A body with no valid
// field at all is a 400, not a silent no-op write.

export const WALLET_INT_FIELDS = [
  "dailyTokenBudget",
  "maxTokensPerConversation",
  "maxSimultaneousConversations",
  "maxAgentCallsPerDay",
  "spendingAuthorityCents",
] as const;

export const WALLET_AUTONOMY_MODES = ["observe", "assist", "autonomous"] as const;

const MAX_INT4 = 2_147_483_647;

export type WalletPatch = {
  dailyTokenBudget?: number;
  maxTokensPerConversation?: number;
  maxSimultaneousConversations?: number;
  maxAgentCallsPerDay?: number;
  spendingAuthorityCents?: number;
  autonomyMode?: (typeof WALLET_AUTONOMY_MODES)[number];
};

export function validateWalletPatch(
  body: unknown,
): { patch: WalletPatch } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "wallet patch must be a JSON object" };
  }
  const patch: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if ((WALLET_INT_FIELDS as readonly string[]).includes(key)) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_INT4
      ) {
        return { error: `${key} must be a number between 0 and ${MAX_INT4}` };
      }
      patch[key] = Math.floor(value);
    } else if (key === "autonomyMode") {
      if (
        typeof value !== "string" ||
        !(WALLET_AUTONOMY_MODES as readonly string[]).includes(value)
      ) {
        return { error: `autonomyMode must be one of ${WALLET_AUTONOMY_MODES.join(", ")}` };
      }
      patch[key] = value;
    }
    // Unknown keys are ignored — never passed into .set().
  }
  if (Object.keys(patch).length === 0) {
    return { error: "no valid wallet fields in patch" };
  }
  return { patch: patch as WalletPatch };
}
