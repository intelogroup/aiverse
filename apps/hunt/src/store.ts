/** Row types + queries over the §5 schema. */
import type { Database } from "bun:sqlite";
import { newId } from "./tokens";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
  gateway_owner_id: string | null;
  status: string;
  publicity_opt_out: number;
}

export interface EventRow {
  id: string;
  slug: string;
  title: string;
  district: string;
  starts_at: number;
  ends_at: number;
  state: string;
  pool_cap_cents: number;
  claim_radius_m: number;
  tier: string;
  created_by: string;
  created_at: number;
}

export interface PrizeRow {
  id: string;
  event_id: string;
  label_public: string;
  kind: string;
  face_value_cents: number;
  x: number;
  y: number;
  z: number;
  code_encrypted: Buffer;
  code_nonce: Buffer;
  state: string;
  claimed_by_user_id: string | null;
  claimed_at: number | null;
  reveal_count: number;
  created_at: number;
}

export interface HintRow {
  id: string;
  event_id: string;
  tier: string;
  text: string;
  fires_at: number | null;
  progress_kind: string | null;
  progress_value: number | null;
  area_x: number | null;
  area_z: number | null;
  area_radius_m: number | null;
  fired_at: number | null;
}

/** Stored state, corrected by the server clock (ticker emits on transitions;
 * reads derive the same answer even if the ticker hasn't run yet). */
export function effectiveState(ev: EventRow, now: number): string {
  if (ev.state === "scheduled" && now >= ev.starts_at && now < ev.ends_at) return "live";
  if ((ev.state === "scheduled" || ev.state === "live") && now >= ev.ends_at) return "ended";
  return ev.state;
}

export function getEventBySlug(db: Database, slug: string): EventRow | null {
  return (db.query("SELECT * FROM events WHERE slug = ?").get(slug) as EventRow) ?? null;
}
export function getEventById(db: Database, id: string): EventRow | null {
  return (db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow) ?? null;
}
export function getUserById(db: Database, id: string): UserRow | null {
  return (db.query("SELECT * FROM hunt_users WHERE id = ?").get(id) as UserRow) ?? null;
}

export function poolSeededTotal(db: Database, eventId: string): number {
  const r = db
    .query(
      "SELECT COALESCE(SUM(face_value_cents),0) AS total FROM prizes WHERE event_id = ? AND state != 'voided'",
    )
    .get(eventId) as { total: number };
  return r.total;
}

export function ledgerInsert(
  db: Database,
  eventId: string,
  entryType: string,
  prizeId: string | null,
  amountCents: number,
  now: number,
  note: string | null = null,
): void {
  db.query(
    "INSERT INTO pool_ledger (id, event_id, entry_type, prize_id, amount_cents, created_at, note) VALUES (?,?,?,?,?,?,?)",
  ).run(newId(), eventId, entryType, prizeId, amountCents, now, note);
}

export function auditInsert(
  db: Database,
  actor: string,
  action: string,
  subject: string,
  detail: unknown,
  now: number,
): void {
  db.query(
    "INSERT INTO audit_log (id, actor, action, subject, detail_json, created_at) VALUES (?,?,?,?,?,?)",
  ).run(newId(), actor, action, subject, detail == null ? null : JSON.stringify(detail), now);
}

export function announcementInsert(
  db: Database,
  eventId: string | null,
  type: string,
  payload: Record<string, unknown>,
  now: number,
): number {
  const r = db
    .query("INSERT INTO announcements (event_id, type, payload_json, created_at) VALUES (?,?,?,?)")
    .run(eventId, type, JSON.stringify(payload), now);
  return Number(r.lastInsertRowid);
}

export function prizeCounts(db: Database, eventId: string): { total: number; claimed: number } {
  const r = db
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state = 'claimed' THEN 1 ELSE 0 END) AS claimed
       FROM prizes WHERE event_id = ? AND state != 'voided'`,
    )
    .get(eventId) as { total: number; claimed: number | null };
  return { total: r.total, claimed: r.claimed ?? 0 };
}
