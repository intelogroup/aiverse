/**
 * Payouts service layer — Phase 2 cash rail (money amendment §§3/6/7).
 *
 * The rules this file exists to enforce, each proven by a test:
 *  - A payout goes ONLY to a verified payout address (§5.7): the send
 *    path refuses by construction when the winner has no address row or
 *    its verified_at is NULL — before any PayPal call is made.
 *  - One payout per verified person per event (amendment §6): a second
 *    cash prize for the same winner in the same event is refused.
 *  - Idempotency: sender_batch_id is a pure function of (mode, prize).
 *    Retrying an ambiguous submit replays the SAME key, which PayPal
 *    dedupes — no code path in this service can mint a second key for
 *    the same win, and `payouts.prize_id` is UNIQUE as the DB backstop.
 *  - 1099 totals (amendment §7): a winner's yearly total moves ONLY on
 *    the transition into SUCCESS, inside one transaction, so observing
 *    the same win via poll AND webhook still counts it exactly once.
 *
 * A submit that fails (PayPal error or network) leaves the row in
 * `created` with the failure recorded: the row means "not known to be
 * submitted", and only a retry with the same idempotency key can move
 * it. `failed` is reserved for PayPal item-level terminal states.
 */
import type { Database } from "bun:sqlite";
import type { PaypalConfig } from "./config";
import { PaypalClient, PaypalError } from "./paypal";
import { auditInsert } from "./store";
import { newId } from "./tokens";

export type PayoutStatus =
  | "created"
  | "pending"
  | "processing"
  | "success"
  | "unclaimed"
  | "returned"
  | "failed"
  | "blocked"
  | "denied"
  | "unknown";

export interface PayoutRow {
  id: string;
  prize_id: string;
  event_id: string;
  user_id: string;
  amount_cents: number;
  currency: string;
  mode: string;
  recipient: string;
  sender_batch_id: string;
  sender_item_id: string;
  batch_id: string | null;
  item_id: string | null;
  transaction_id: string | null;
  status: PayoutStatus;
  failure: string | null;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
}

export class PayoutError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PayoutError";
    this.code = code;
  }
}

/** Amendment §7: 1099 reporting threshold, per winner per year (USD). */
export const TAX_REPORT_THRESHOLD_CENTS = 600_00;
/** Cash rides USD for v1 (amendment §7 geography is US-first). */
export const PAYOUT_CURRENCY = "USD";

/** The idempotency key: a pure function of the win. Never random, never re-minted. */
export function senderBatchIdFor(mode: string, prizeId: string): string {
  return `hunt-${mode === "live" ? "live" : "sbx"}-${prizeId}`;
}

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Public receipt masking: j•••@example.com — full addresses stay owner/admin-side. */
export function maskAddress(address: string): string {
  const at = address.indexOf("@");
  if (at < 1) return "•••";
  return `${address.slice(0, 1)}•••${address.slice(at)}`;
}

/** Map a PayPal payout-item transaction_status onto the local vocabulary. */
export function mapPaypalItemStatus(tx: string | null | undefined): PayoutStatus {
  switch ((tx ?? "").toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "PENDING":
      return "pending";
    case "UNCLAIMED":
      return "unclaimed";
    case "RETURNED":
    case "REFUNDED":
      return "returned";
    case "FAILED":
      return "failed";
    case "BLOCKED":
      return "blocked";
    case "DENIED":
      return "denied";
    default:
      return "unknown";
  }
}

/** Batch-level fallback at submit time, when no item status is present yet. */
function mapPaypalBatchStatus(tx: string | null | undefined): PayoutStatus {
  switch ((tx ?? "").toUpperCase()) {
    case "PENDING":
      return "pending";
    case "DENIED":
      return "denied";
    default:
      return "processing"; // batch accepted; the item read settles the truth
  }
}

export function getPayoutById(db: Database, id: string): PayoutRow | null {
  return (db.query("SELECT * FROM payouts WHERE id = ?").get(id) as PayoutRow) ?? null;
}
export function getPayoutByPrize(db: Database, prizeId: string): PayoutRow | null {
  return (db.query("SELECT * FROM payouts WHERE prize_id = ?").get(prizeId) as PayoutRow) ?? null;
}
export function getPayoutByItemId(db: Database, itemId: string): PayoutRow | null {
  return (db.query("SELECT * FROM payouts WHERE item_id = ?").get(itemId) as PayoutRow) ?? null;
}

/** The ONLY read of the recipient the send path is allowed to make. */
export function verifiedAddressFor(db: Database, userId: string): string | null {
  const row = db
    .query("SELECT address, verified_at FROM payout_addresses WHERE user_id = ? AND kind = 'paypal'")
    .get(userId) as { address: string; verified_at: number | null } | null;
  if (!row || row.verified_at == null) return null;
  return row.address;
}

/** Per-person yearly total (the 1099 hook) — SUCCESS money only, by construction. */
export function yearTotalCents(db: Database, userId: string, mode: string, year: number): number {
  const row = db
    .query("SELECT total_cents FROM payout_year_totals WHERE user_id = ? AND mode = ? AND year = ?")
    .get(userId, mode, year) as { total_cents: number } | null;
  return row?.total_cents ?? 0;
}

export function meetsTaxThreshold(totalCents: number): boolean {
  return totalCents >= TAX_REPORT_THRESHOLD_CENTS;
}

export function buildBatchBody(row: PayoutRow): unknown {
  return {
    sender_batch_header: {
      sender_batch_id: row.sender_batch_id,
      recipient_type: "EMAIL",
      email_subject: "Your AIVerse hunt prize",
      email_message: "Your treasure hunt prize payout from AIVerse.",
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: row.recipient,
        amount: { value: formatAmount(row.amount_cents), currency: row.currency },
        sender_item_id: row.sender_item_id,
        note: "AIVerse treasure hunt prize",
      },
    ],
  };
}

interface PrizeFacts {
  id: string;
  event_id: string;
  state: string;
  face_value_cents: number;
  claimed_by_user_id: string | null;
}

/**
 * Create (or resume) the payout for a claimed prize and submit it to
 * PayPal. Returns the payout row. Idempotent: calling this twice for the
 * same win performs at most one NEW PayPal submission, and a resubmit
 * after an ambiguous failure carries the identical sender_batch_id.
 */
export async function initiatePayout(
  db: Database,
  client: PaypalClient,
  mode: string,
  prizeId: string,
  now: number,
  actor = "admin",
): Promise<PayoutRow> {
  const prize = db.query("SELECT * FROM prizes WHERE id = ?").get(prizeId) as PrizeFacts | null;
  if (!prize) throw new PayoutError("prize_not_found");
  if (prize.state !== "claimed" || !prize.claimed_by_user_id) {
    throw new PayoutError("prize_not_claimed", "only a claimed prize can be paid");
  }
  if (!Number.isInteger(prize.face_value_cents) || prize.face_value_cents <= 0) {
    throw new PayoutError("prize_has_no_cash_value");
  }

  let row = getPayoutByPrize(db, prizeId);
  if (row && row.batch_id) return row; // already submitted — nothing to do

  if (!row) {
    const winnerId = prize.claimed_by_user_id;
    const winner = db.query("SELECT status FROM hunt_users WHERE id = ?").get(winnerId) as {
      status: string;
    } | null;
    if (!winner || winner.status !== "active") {
      throw new PayoutError("winner_not_active", "a suspended winner is a review case, never an auto-pay");
    }
    const address = verifiedAddressFor(db, winnerId);
    if (!address) {
      throw new PayoutError(
        "payout_address_unverified",
        "cash waits for a verified payout address (amendment §6)",
      );
    }
    // One payout per verified person per event (amendment §6). The check
    // and the insert share one IMMEDIATE transaction; prize_id UNIQUE is
    // the backstop if this code is ever wrong.
    db.exec("BEGIN IMMEDIATE");
    try {
      const clash = db
        .query("SELECT id FROM payouts WHERE event_id = ? AND user_id = ? LIMIT 1")
        .get(prize.event_id, winnerId);
      if (clash) {
        db.exec("ROLLBACK");
        throw new PayoutError("one_payout_per_event");
      }
      const id = newId();
      db.query(
        `INSERT INTO payouts (id, prize_id, event_id, user_id, amount_cents, currency, mode,
           recipient, sender_batch_id, sender_item_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'created', ?, ?)`,
      ).run(
        id,
        prize.id,
        prize.event_id,
        winnerId,
        prize.face_value_cents,
        PAYOUT_CURRENCY,
        mode,
        address,
        senderBatchIdFor(mode, prize.id),
        prize.id,
        now,
        now,
      );
      db.exec("COMMIT");
      auditInsert(db, actor, "payout_initiated", id, { prize_id: prize.id, amount_cents: prize.face_value_cents }, now);
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
    row = getPayoutByPrize(db, prizeId)!;
  }

  // Submit (or resubmit after an ambiguous failure — same key, see header).
  let res: any;
  try {
    res = await client.createPayoutBatch(buildBatchBody(row));
  } catch (e) {
    const failure =
      e instanceof PaypalError
        ? JSON.stringify({ name: e.paypalName, http: e.status, message: e.message })
        : JSON.stringify({ name: "network_error", message: e instanceof Error ? e.message : String(e) });
    db.query("UPDATE payouts SET failure = ?, updated_at = ? WHERE id = ?").run(failure, now, row.id);
    auditInsert(db, actor, "payout_submit_failed", row.id, { retry: "same sender_batch_id" }, now);
    return getPayoutById(db, row.id)!;
  }
  const header = res?.batch_header ?? {};
  const item = Array.isArray(res?.items) ? res.items[0] : null;
  const status = item?.transaction_status
    ? mapPaypalItemStatus(item.transaction_status)
    : mapPaypalBatchStatus(header.batch_status);
  return applyPayoutStatus(
    db,
    row.id,
    status,
    {
      batchId: header.payout_batch_id ?? null,
      itemId: item?.payout_item_id ?? null,
      transactionId: item?.transaction_id ?? null,
    },
    now,
    actor,
  );
}

/**
 * The single funnel for status changes — poll and webhook both land
 * here, so the SUCCESS bookkeeping (paid_at + yearly total) runs exactly
 * once no matter which path observes the win first.
 */
export function applyPayoutStatus(
  db: Database,
  payoutId: string,
  status: PayoutStatus,
  ids: { batchId?: string | null; itemId?: string | null; transactionId?: string | null },
  now: number,
  actor = "system",
): PayoutRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = getPayoutById(db, payoutId);
    if (!row) {
      db.exec("ROLLBACK");
      throw new PayoutError("payout_not_found");
    }
    const becomingSuccess = status === "success" && row.status !== "success" && row.paid_at == null;
    db.query(
      `UPDATE payouts SET status = ?,
         batch_id = COALESCE(?, batch_id),
         item_id = COALESCE(?, item_id),
         transaction_id = COALESCE(?, transaction_id),
         paid_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      ids.batchId ?? null,
      ids.itemId ?? null,
      ids.transactionId ?? null,
      becomingSuccess ? now : row.paid_at,
      now,
      payoutId,
    );
    if (becomingSuccess) {
      const year = new Date(now).getUTCFullYear();
      db.query(
        `INSERT INTO payout_year_totals (user_id, mode, year, total_cents, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id, mode, year)
         DO UPDATE SET total_cents = total_cents + excluded.total_cents, updated_at = excluded.updated_at`,
      ).run(row.user_id, row.mode, year, row.amount_cents, now);
    }
    if (row.status !== status) {
      auditInsert(db, actor, "payout_status", payoutId, { from: row.status, to: status }, now);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
  return getPayoutById(db, payoutId)!;
}

/** Poll PayPal for the current item state and settle the local row. */
export async function refreshPayout(
  db: Database,
  client: PaypalClient,
  payoutId: string,
  now: number,
): Promise<PayoutRow> {
  const row = getPayoutById(db, payoutId);
  if (!row) throw new PayoutError("payout_not_found");
  if (!row.batch_id) return row; // never submitted — nothing to poll
  let status: PayoutStatus;
  let transactionId: string | null = null;
  if (row.item_id) {
    const item = await client.getPayoutItem(row.item_id);
    status = mapPaypalItemStatus(item?.transaction_status);
    transactionId = item?.transaction_id ?? null;
  } else {
    const batch = await client.getPayoutBatch(row.batch_id);
    const item = Array.isArray(batch?.items) ? batch.items[0] : null;
    status = item?.transaction_status
      ? mapPaypalItemStatus(item.transaction_status)
      : mapPaypalBatchStatus(batch?.batch_header?.batch_status);
    transactionId = item?.transaction_id ?? null;
    if (item?.payout_item_id) {
      return applyPayoutStatus(db, payoutId, status, { itemId: item.payout_item_id, transactionId }, now);
    }
  }
  return applyPayoutStatus(db, payoutId, status, { transactionId }, now);
}

export interface WebhookOutcome {
  accepted: boolean;
  reason?: string;
}

/**
 * Webhook intake for PAYMENT.PAYOUTS-ITEM.* events. Signature first —
 * nothing is read from the event until PayPal's verify call says the
 * transmission is genuine. Absent webhook id = reject (never a soft
 * accept). Signed-but-unrelated events are accepted and ignored, so
 * PayPal does not retry them forever.
 */
export async function handlePayoutWebhook(
  db: Database,
  client: PaypalClient,
  cfg: PaypalConfig,
  headers: {
    authAlgo: string | null;
    certUrl: string | null;
    transmissionId: string | null;
    transmissionSig: string | null;
    transmissionTime: string | null;
  },
  event: any,
  now: number,
): Promise<WebhookOutcome> {
  if (!cfg.webhookId) return { accepted: false, reason: "webhook_id_unconfigured" };
  const verified = await client.verifyWebhookSignature({
    ...headers,
    webhookId: cfg.webhookId,
    webhookEvent: event,
  });
  if (!verified) return { accepted: false, reason: "signature_verification_failed" };
  const type = typeof event?.event_type === "string" ? event.event_type : "";
  if (!type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    return { accepted: true, reason: "ignored_event_type" };
  }
  const resource = event?.resource ?? {};
  const itemId = typeof resource.payout_item_id === "string" ? resource.payout_item_id : null;
  const row = itemId ? getPayoutByItemId(db, itemId) : null;
  if (!row) return { accepted: true, reason: "unknown_item" };
  applyPayoutStatus(
    db,
    row.id,
    mapPaypalItemStatus(resource.transaction_status),
    {
      batchId: typeof resource.payout_batch_id === "string" ? resource.payout_batch_id : null,
      transactionId: typeof resource.transaction_id === "string" ? resource.transaction_id : null,
    },
    now,
    "system",
  );
  return { accepted: true };
}
