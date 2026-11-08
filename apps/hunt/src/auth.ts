/**
 * Identity (SPEC §4): email magic-link → 30-day session bearer.
 * Only SHA-256 hashes of tokens are ever stored.
 */
import type { Database } from "bun:sqlite";
import type { Mailer } from "./mailer";
import { hashToken, newId, newToken } from "./tokens";
import { getUserById, type UserRow } from "./store";

export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function findOrCreateUser(db: Database, emailRaw: string, now: number): UserRow {
  const email = emailRaw.trim().toLowerCase();
  const existing = db.query("SELECT * FROM hunt_users WHERE email = ?").get(email) as UserRow | null;
  if (existing) return existing;
  const id = newId();
  const display = email.split("@")[0] || "hunter";
  db.query(
    "INSERT INTO hunt_users (id, email, display_name, created_at) VALUES (?,?,?,?)",
  ).run(id, email, display, now);
  return getUserById(db, id)!;
}

/** Always succeeds silently at the HTTP layer (no account enumeration). */
export async function requestMagicLink(
  db: Database,
  mailer: Mailer,
  publicBase: string,
  emailRaw: string,
  now: number,
): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  const user = findOrCreateUser(db, email, now);
  const token = newToken();
  db.query(
    "INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES (?,?, 'magic', ?, ?, ?)",
  ).run(newId(), user.id, hashToken(token), now + MAGIC_TTL_MS, now);
  const link = `${publicBase}/v1/auth/consume?token=${encodeURIComponent(token)}`;
  await mailer.sendMagicLink(email, link);
}

/** Consume a magic token (single-use); returns a fresh session token or null. */
export function consumeMagicLink(db: Database, rawToken: string, now: number): string | null {
  const row = db
    .query("SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'magic'")
    .get(hashToken(rawToken)) as
    | { id: string; user_id: string; expires_at: number; consumed_at: number | null }
    | null;
  if (!row || row.consumed_at !== null || row.expires_at <= now) return null;
  db.query("UPDATE auth_tokens SET consumed_at = ? WHERE id = ?").run(now, row.id);
  const session = newToken();
  db.query(
    "INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES (?,?, 'session', ?, ?, ?)",
  ).run(newId(), row.user_id, hashToken(session), now + SESSION_TTL_MS, now);
  return session;
}

export function userForSession(db: Database, rawToken: string, now: number): UserRow | null {
  const row = db
    .query("SELECT user_id, expires_at FROM auth_tokens WHERE token_hash = ? AND kind = 'session'")
    .get(hashToken(rawToken)) as { user_id: string; expires_at: number } | null;
  if (!row || row.expires_at <= now) return null;
  return getUserById(db, row.user_id);
}

export function bearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : null;
}
