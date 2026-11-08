/**
 * The claim pipeline (SPEC §6) — shared by POST /v1/claims and, for
 * continuous checks (hunt v0 delta 1), POST /v1/positions pings.
 *
 * Check order is the spec's: session state → event window → rate limit →
 * speed plausibility → radius → atomic win → decrypt (custody path (a)).
 * No prize id is ever accepted from the client.
 */
import type { Database } from "bun:sqlite";
import { GLOBAL_SPEED_CEILING_MPS, SPEED_TOLERANCE } from "./config";
import { decryptCode } from "./custody";
import {
  announcementInsert,
  auditInsert,
  effectiveState,
  ledgerInsert,
  type EventRow,
  type PrizeRow,
  type UserRow,
} from "./store";
import { newId } from "./tokens";

export interface Position {
  x: number;
  y: number;
  z: number;
}

export type ClaimResult =
  | { result: "won"; label: string; kind: string; code: string }
  | { result: "no_prize_in_radius" }
  | { result: "already_claimed" }
  | { result: "too_fast" }
  | { result: "rate_limited"; retry_after_s: number }
  | { result: "event_not_live" }
  | { result: "suspended_user" };

/** In-process rate limiter (SPEC §7): 1 attempt / 2 s / user, 60 / min /
 * user, plus an event-wide burst cap of 300 / min [ASSUMPTION: starting
 * values, tuned after live hunt data]. */
export class RateLimiter {
  private byUser = new Map<string, number[]>();
  private byEvent = new Map<string, number[]>();
  constructor(
    private minIntervalMs = 2000,
    private perUserPerMin = 60,
    private perEventPerMin = 300,
  ) {}

  /** Returns retry-after seconds if limited, else null. Does not record. */
  check(userId: string, eventId: string, now: number): number | null {
    const u = prune(this.byUser.get(userId) ?? [], now);
    this.byUser.set(userId, u);
    if (u.length > 0 && now - u[u.length - 1] < this.minIntervalMs) {
      return Math.max(1, Math.ceil((this.minIntervalMs - (now - u[u.length - 1])) / 1000));
    }
    if (u.length >= this.perUserPerMin) {
      return Math.max(1, Math.ceil((u[0] + 60_000 - now) / 1000));
    }
    const e = prune(this.byEvent.get(eventId) ?? [], now);
    this.byEvent.set(eventId, e);
    if (e.length >= this.perEventPerMin) {
      return Math.max(1, Math.ceil((e[0] + 60_000 - now) / 1000));
    }
    return null;
  }

  record(userId: string, eventId: string, now: number): void {
    const u = this.byUser.get(userId) ?? [];
    u.push(now);
    this.byUser.set(userId, u);
    const e = this.byEvent.get(eventId) ?? [];
    e.push(now);
    this.byEvent.set(eventId, e);
  }
}

function prune(ts: number[], now: number): number[] {
  const cut = now - 60_000;
  let i = 0;
  while (i < ts.length && ts[i] <= cut) i++;
  return ts.slice(i);
}

export function bodyCapMps(db: Database, bodyId: string): number {
  const row = db.query("SELECT max_speed_mps FROM body_constants WHERE body_id = ?").get(bodyId) as
    | { max_speed_mps: number }
    | null;
  return row ? row.max_speed_mps : GLOBAL_SPEED_CEILING_MPS;
}

function logAttempt(
  db: Database,
  args: {
    eventId: string;
    prizeId: string | null;
    userId: string;
    pos: Position;
    bodyId: string;
    clientTs: number | null;
    now: number;
    verdict: string;
    distanceM: number | null;
    via: string;
  },
): void {
  db.query(
    `INSERT INTO claim_attempts (id, event_id, prize_id, user_id, x, y, z, body_id, client_ts, received_at, verdict, distance_m, via)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId(),
    args.eventId,
    args.prizeId,
    args.userId,
    args.pos.x,
    args.pos.y,
    args.pos.z,
    args.bodyId,
    args.clientTs,
    args.now,
    args.verdict,
    args.distanceM,
    args.via,
  );
}

function logSample(
  db: Database,
  userId: string,
  eventId: string,
  pos: Position,
  bodyId: string,
  now: number,
): void {
  db.query(
    "INSERT INTO position_samples (id, user_id, event_id, x, y, z, body_id, received_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(newId(), userId, eventId, pos.x, pos.y, pos.z, bodyId, now);
}

const horizontal = (a: Position, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

export interface EvaluateArgs {
  user: UserRow;
  event: EventRow;
  bodyId: string;
  position: Position;
  clientTs: number | null;
  via: "claim" | "ping";
  now: number;
  codeKey: Buffer;
  limiter: RateLimiter;
}

/**
 * Runs one claim evaluation. Synchronous (bun:sqlite) — the win transaction
 * cannot interleave with another request in this process, and the I1
 * partial unique index backstops it at the database level regardless.
 */
export function evaluateClaim(db: Database, args: EvaluateArgs): ClaimResult {
  const { user, event, bodyId, position, clientTs, via, now } = args;
  const base = { eventId: event.id, userId: user.id, pos: position, bodyId, clientTs, now, via };

  // 1. User state.
  if (user.status !== "active") {
    logAttempt(db, { ...base, prizeId: null, verdict: "suspended_user", distanceM: null });
    return { result: "suspended_user" };
  }
  // 2. Event window (server clock is authoritative).
  if (effectiveState(event, now) !== "live") {
    logAttempt(db, { ...base, prizeId: null, verdict: "event_not_live", distanceM: null });
    return { result: "event_not_live" };
  }
  // 3. Rate limit.
  const retry = args.limiter.check(user.id, event.id, now);
  if (retry !== null) {
    logAttempt(db, { ...base, prizeId: null, verdict: "rate_limited", distanceM: null });
    args.limiter.record(user.id, event.id, now);
    return { result: "rate_limited", retry_after_s: retry };
  }
  args.limiter.record(user.id, event.id, now);

  // 4. Speed plausibility vs this user's last accepted sample in the event.
  const last = db
    .query(
      "SELECT x, z, received_at FROM position_samples WHERE user_id = ? AND event_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 1",
    )
    .get(user.id, event.id) as { x: number; z: number; received_at: number } | null;
  if (last) {
    const dist = horizontal(position, last);
    const dtMs = Math.max(now - last.received_at, 250);
    const speed = dist / (dtMs / 1000);
    if (speed > bodyCapMps(db, bodyId) * SPEED_TOLERANCE) {
      logSample(db, user.id, event.id, position, bodyId, now); // still logged (§6.2.4)
      logAttempt(db, { ...base, prizeId: null, verdict: "too_fast", distanceM: null });
      return { result: "too_fast" };
    }
  }
  logSample(db, user.id, event.id, position, bodyId, now);

  // 5. Radius search (horizontal distance; y is logged for replay).
  const radius = event.claim_radius_m;
  const inRadius = (
    db
      .query("SELECT * FROM prizes WHERE event_id = ? AND state IN ('seeded','claimed')")
      .all(event.id) as PrizeRow[]
  )
    .map((p) => ({ p, d: horizontal(position, p) }))
    .filter((r) => r.d <= radius)
    .sort((a, b) => a.d - b.d);
  const candidate = inRadius.find((r) => r.p.state === "seeded");

  if (!candidate) {
    if (inRadius.length > 0) {
      logAttempt(db, {
        ...base,
        prizeId: inRadius[0].p.id,
        verdict: "already_claimed",
        distanceM: inRadius[0].d,
      });
      return { result: "already_claimed" };
    }
    logAttempt(db, { ...base, prizeId: null, verdict: "no_prize_in_radius", distanceM: null });
    return { result: "no_prize_in_radius" };
  }

  // 6. Atomic win — one BEGIN IMMEDIATE transaction.
  const prize = candidate.p;
  let won = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const fresh = db.query("SELECT state FROM prizes WHERE id = ?").get(prize.id) as {
      state: string;
    };
    if (fresh.state === "seeded") {
      db.query(
        "UPDATE prizes SET state = 'claimed', claimed_by_user_id = ?, claimed_at = ?, reveal_count = reveal_count + 1 WHERE id = ?",
      ).run(user.id, now, prize.id);
      logAttempt(db, { ...base, prizeId: prize.id, verdict: "won", distanceM: candidate.d });
      ledgerInsert(db, event.id, "claim_award", prize.id, prize.face_value_cents, now);
      announcementInsert(
        db,
        event.id,
        "prize_claimed",
        {
          event_slug: event.slug,
          prize_label: prize.label_public,
          winner_display_name: user.publicity_opt_out ? "a hunter" : user.display_name,
        },
        now,
      );
      won = true;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    // I1 backstop tripped (unique index on won attempts) → the prize is gone.
    logAttempt(db, { ...base, prizeId: prize.id, verdict: "already_claimed", distanceM: candidate.d });
    return { result: "already_claimed" };
  }
  if (!won) {
    logAttempt(db, { ...base, prizeId: prize.id, verdict: "already_claimed", distanceM: candidate.d });
    return { result: "already_claimed" };
  }

  // 7. Only now decrypt — custody path (a), for the winner's response only.
  const code = decryptCode(args.codeKey, {
    ciphertext: prize.code_encrypted,
    nonce: prize.code_nonce,
  });
  return { result: "won", label: prize.label_public, kind: prize.kind, code };
}

/** Winner-only re-read of their own codes (SPEC §6.3); audit-logged. */
export function listWins(
  db: Database,
  user: UserRow,
  codeKey: Buffer,
  now: number,
): { event_slug: string; label: string; kind: string; code: string; claimed_at: number }[] {
  const rows = db
    .query(
      `SELECT p.label_public, p.kind, p.code_encrypted, p.code_nonce, p.claimed_at, e.slug
       FROM prizes p JOIN events e ON e.id = p.event_id
       WHERE p.claimed_by_user_id = ? AND p.state = 'claimed' ORDER BY p.claimed_at`,
    )
    .all(user.id) as {
    label_public: string;
    kind: string;
    code_encrypted: Buffer;
    code_nonce: Buffer;
    claimed_at: number;
    slug: string;
  }[];
  if (rows.length > 0) {
    auditInsert(db, `user:${user.id}`, "win_reread", user.id, { count: rows.length }, now);
  }
  return rows.map((r) => ({
    event_slug: r.slug,
    label: r.label_public,
    kind: r.kind,
    code: decryptCode(codeKey, { ciphertext: r.code_encrypted, nonce: r.code_nonce }),
    claimed_at: r.claimed_at,
  }));
}
