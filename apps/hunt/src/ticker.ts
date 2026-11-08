/**
 * The 1-second ticker (SPEC §8.1): event state transitions and hint firing
 * against the server clock. Hint pacing is progress-first (hunt v0 delta 3):
 * a rung fires when its progress trigger is met OR its scheduled time
 * arrives — whichever comes first — and only while its tier's prizes remain
 * unclaimed. All state is re-derived from stored rows, so a restart loses
 * nothing.
 */
import type { Database } from "bun:sqlite";
import {
  announcementInsert,
  ledgerInsert,
  prizeCounts,
  type EventRow,
  type HintRow,
} from "./store";

const TIER_ORDER = ["district", "neighbourhood", "street", "room"] as const;

function tierPrizesRemain(db: Database, ev: EventRow): boolean {
  const { total, claimed } = prizeCounts(db, ev.id);
  return total > 0 && claimed < total;
}

function progressMet(db: Database, ev: EventRow, hint: HintRow): boolean {
  if (!hint.progress_kind || hint.progress_value == null) return false;
  if (hint.progress_kind === "prizes_claimed_fraction") {
    const { total, claimed } = prizeCounts(db, ev.id);
    return total > 0 && claimed / total >= hint.progress_value;
  }
  if (hint.progress_kind === "hunters_in_area") {
    if (hint.area_x == null || hint.area_z == null || hint.area_radius_m == null) return false;
    // Active hunters = users with ≥1 sample this event; converged = their
    // latest sample sits inside this rung's disc.
    const hunters = db
      .query(
        `SELECT user_id, x, z FROM position_samples
         WHERE event_id = ? AND (user_id, received_at) IN (
           SELECT user_id, MAX(received_at) FROM position_samples WHERE event_id = ? GROUP BY user_id
         )`,
      )
      .all(ev.id, ev.id) as { user_id: string; x: number; z: number }[];
    if (hunters.length === 0) return false;
    const inside = hunters.filter(
      (h) => Math.hypot(h.x - hint.area_x!, h.z - hint.area_z!) <= hint.area_radius_m!,
    ).length;
    return inside / hunters.length >= hint.progress_value;
  }
  return false;
}

function emitPrivatePing(db: Database, ev: EventRow, kind: string, now: number): void {
  announcementInsert(
    db,
    ev.id,
    "ping",
    { kind, prize_class: ev.tier, expiry: ev.ends_at },
    now,
  );
}

export function tickOnce(db: Database, now: number): void {
  const events = db
    .query("SELECT * FROM events WHERE state IN ('scheduled','live','paused')")
    .all() as unknown as EventRow[];

  for (const ev of events) {
    // Transitions.
    if (ev.state === "scheduled" && now >= ev.starts_at && now < ev.ends_at) {
      db.query("UPDATE events SET state = 'live' WHERE id = ?").run(ev.id);
      announcementInsert(
        db,
        ev.id,
        "hunt_start",
        {
          event_slug: ev.slug,
          title: ev.title,
          district: ev.district,
          pool_label: poolLabel(db, ev),
          ends_at: ev.ends_at,
          tier: ev.tier,
        },
        now,
      );
      emitPrivatePing(db, ev, "hunt_start", now);
      ev.state = "live";
    }
    if ((ev.state === "live" || ev.state === "paused") && now >= ev.ends_at) {
      db.query("UPDATE events SET state = 'ended' WHERE id = ?").run(ev.id);
      // Unclaimed prizes expire; the pool returns (ledger expire_return).
      const live = db
        .query("SELECT id, face_value_cents FROM prizes WHERE event_id = ? AND state = 'seeded'")
        .all(ev.id) as { id: string; face_value_cents: number }[];
      for (const p of live) {
        db.query("UPDATE prizes SET state = 'expired' WHERE id = ?").run(p.id);
        ledgerInsert(db, ev.id, "expire_return", p.id, p.face_value_cents, now);
      }
      const { total, claimed } = prizeCounts(db, ev.id);
      announcementInsert(
        db,
        ev.id,
        "hunt_end",
        { event_slug: ev.slug, claimed_count: claimed, total_count: total },
        now,
      );
      continue;
    }
    if (ev.state !== "live") continue;

    // Hints for the live event.
    const hints = db
      .query("SELECT * FROM hint_schedule WHERE event_id = ? AND fired_at IS NULL ORDER BY rowid")
      .all(ev.id) as unknown as HintRow[];
    for (const hint of hints) {
      if (!tierPrizesRemain(db, ev)) break;
      const byTime = hint.fires_at != null && now >= hint.fires_at;
      const byProgress = progressMet(db, ev, hint);
      if (!byTime && !byProgress) continue;
      db.query("UPDATE hint_schedule SET fired_at = ? WHERE id = ?").run(now, hint.id);
      announcementInsert(
        db,
        ev.id,
        "hint",
        { event_slug: ev.slug, tier: hint.tier, text: hint.text },
        now,
      );
      emitPrivatePing(db, ev, `hint:${hint.tier}`, now);
    }
  }

  // Review-window pruning [ASSUMPTION: 90 days] for position trails.
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;
  db.query("DELETE FROM position_samples WHERE received_at < ?").run(cutoff);
}

function poolLabel(db: Database, ev: EventRow): string {
  const { total } = prizeCounts(db, ev.id);
  const sum = db
    .query(
      "SELECT COALESCE(SUM(face_value_cents),0) AS s FROM prizes WHERE event_id = ? AND state != 'voided'",
    )
    .get(ev.id) as { s: number };
  return `$${(sum.s / 100).toFixed(0)} in codes across ${total} prizes`;
}

export function startTicker(db: Database, intervalMs = 1000): Timer {
  const timer = setInterval(() => {
    try {
      tickOnce(db, Date.now());
    } catch (err) {
      console.error("[hunt:ticker]", err);
    }
  }, intervalMs);
  return timer;
}

export { TIER_ORDER };
