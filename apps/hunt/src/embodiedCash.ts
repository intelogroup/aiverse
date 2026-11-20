import type { Database } from "bun:sqlite";
import { userForGatewayOwner, type GatewayIdentity } from "./auth";
import { encryptCode } from "./custody";
import { getPayoutByPrize, PayoutError, verifiedAddressFor } from "./payouts";
import { auditInsert, ledgerInsert } from "./store";

export interface EmbodiedCashWin {
  contestId: string;
  owner: GatewayIdentity;
  amountCents: number;
  mode: "sandbox" | "live";
  wonAt: number;
}

export type PublishEmbodiedCashBounty = (
  input: unknown, mode: EmbodiedCashWin["mode"],
) => Promise<
  | { bounty: { id: string; clue: string; amountCents: number; mode: EmbodiedCashWin["mode"]; expiresAt?: string } }
  | { error: "invalid_cash_bounty" | "cash_bounty_already_open" }
>;

export const EMBODIED_CASH_PRIZE_PREFIX = "embodied-cash-";
export const embodiedCashPrizeId = (contestId: string) => EMBODIED_CASH_PRIZE_PREFIX + contestId;

export function prepareEmbodiedCashPrize(db: Database, codeKey: Buffer, win: EmbodiedCashWin, now: number) {
  const prizeId = embodiedCashPrizeId(win.contestId);
  const address = win.owner.email;

  return db.transaction(() => {
    const linked = db.query("SELECT gateway_owner_id FROM hunt_users WHERE email = ?").get(address) as
      { gateway_owner_id: string | null } | null;
    if (linked?.gateway_owner_id && linked.gateway_owner_id !== win.owner.ownerId) {
      throw new PayoutError("cash_owner_conflict");
    }
    const user = userForGatewayOwner(db, win.owner, now);
    if (user.status !== "active") throw new PayoutError("winner_not_active");

    const existing = getPayoutByPrize(db, prizeId);
    if (existing && (existing.user_id !== user.id || existing.recipient !== address ||
        existing.amount_cents !== win.amountCents || existing.mode !== win.mode)) {
      throw new PayoutError("cash_approval_changed");
    }
    if (existing?.batch_id) return prizeId;
    // PayPal deduplicates a sender batch for 30 days. This also caps retries after a lost ledger restore.
    if (now - win.wonAt >= 30 * 24 * 60 * 60 * 1000) throw new PayoutError("cash_retry_window_expired");

    const addressOwner = db.query("SELECT user_id FROM payout_addresses WHERE address = ?").get(address) as
      { user_id: string } | null;
    if (addressOwner && addressOwner.user_id !== user.id) throw new PayoutError("cash_recipient_conflict");
    db.query(
      "INSERT INTO payout_addresses (user_id, address, verified_at, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING",
    ).run(user.id, address, now, now, now);
    if (verifiedAddressFor(db, user.id) !== address) throw new PayoutError("cash_recipient_conflict");

    const prize = db.query("SELECT claimed_by_user_id, face_value_cents FROM prizes WHERE id = ?").get(prizeId) as
      { claimed_by_user_id: string | null; face_value_cents: number } | null;
    if (prize) {
      if (prize.claimed_by_user_id !== user.id || prize.face_value_cents !== win.amountCents) {
        throw new PayoutError("cash_approval_changed");
      }
      return prizeId;
    }

    // A closed event records the approved pool without offering a second way to win the prize.
    db.query(
      `INSERT INTO events (id, slug, title, district, starts_at, ends_at, state, pool_cap_cents, claim_radius_m, created_by, created_at)
       VALUES (?, ?, 'AIVerse cash bounty', 'City 3', ?, ?, 'ended', ?, 0, 'admin', ?)`,
    ).run(prizeId, prizeId, win.wonAt, now, win.amountCents, now);
    const code = encryptCode(codeKey, "");
    db.query(
      `INSERT INTO prizes (id, event_id, label_public, kind, face_value_cents, x, y, z, code_encrypted, code_nonce,
       state, claimed_by_user_id, claimed_at, created_at)
       VALUES (?, ?, 'AIVerse cash bounty', 'embodied_cash', ?, 0, 0, 0, ?, ?, 'claimed', ?, ?, ?)`,
    ).run(prizeId, prizeId, win.amountCents, code.ciphertext, code.nonce, user.id, win.wonAt, now);
    ledgerInsert(db, prizeId, "seed", prizeId, win.amountCents, now);
    ledgerInsert(db, prizeId, "claim_award", prizeId, win.amountCents, now);
    auditInsert(db, "admin", "embodied_cash_prize_prepared", prizeId, { contest_id: win.contestId }, now);
    return prizeId;
  }).immediate();
}

export function readEmbodiedCashReceipt(db: Database, contestId: string, ownerId: string) {
  return db.query(
    `SELECT po.amount_cents AS amountCents, po.currency, po.mode, po.status, po.transaction_id AS transactionId
     FROM payouts po JOIN hunt_users u ON po.user_id = u.id
     WHERE po.prize_id = ? AND u.gateway_owner_id = ?`,
  ).get(embodiedCashPrizeId(contestId), ownerId) as {
    amountCents: number;
    currency: "USD";
    mode: "sandbox" | "live";
    status: string;
    transactionId: string | null;
  } | null;
}
