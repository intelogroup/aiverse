import { createDbSlot, openDb, type DbSlot } from "../src/db";
import { loadConfig, type HuntConfig } from "../src/config";
import { LogMailer } from "../src/mailer";
import { randomCodeKey } from "../src/custody";
import { buildApp } from "../src/app";
import { RateLimiter } from "../src/claims";
import type { Database } from "bun:sqlite";

export const ADMIN = "test-admin-token-1234";

export interface Harness {
  /** Stable proxy handle (DbSlot) — resolves the current connection,
   *  including after a backup/restore swap. */
  db: Database;
  dbSlot: DbSlot;
  dbPath: string;
  cfg: HuntConfig;
  mailer: LogMailer;
  app: ReturnType<typeof buildApp>;
  codeKey: Buffer;
}

export function makeHarness(
  dbPath = ":memory:",
  limiter?: RateLimiter,
  codeKey?: Buffer,
): Harness {
  const slot = createDbSlot(openDb(dbPath));
  const key = codeKey ?? randomCodeKey();
  const cfg = loadConfig({
    NODE_ENV: "test",
    HUNT_PORT: "8799",
    HUNT_ADMIN_TOKEN: ADMIN,
    HUNT_CODE_KEY: key.toString("base64"),
    HUNT_PUBLIC_BASE: "http://localhost:8799",
    HUNT_CONSOLE_URL: "http://localhost:5173",
    HUNT_DB_PATH: dbPath,
  });
  const mailer = new LogMailer();
  const app = buildApp({ db: slot.db, dbSlot: slot, cfg, mailer, codeKey: key, limiter });
  return { db: slot.db, dbSlot: slot, dbPath, cfg, mailer, app, codeKey: key };
}

export async function req(
  app: Harness["app"],
  method: string,
  path: string,
  opts: { token?: string; admin?: boolean; body?: unknown } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.admin) headers.Authorization = `Bearer ${ADMIN}`;
  else if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}

/** Full magic-link flow; returns the session token + user id. */
export async function makeUser(
  h: Harness,
  email: string,
): Promise<{ session: string; userId: string }> {
  const before = h.mailer.sent.length;
  const r = await req(h.app, "POST", "/v1/auth/magic-link", { body: { email } });
  if (r.status !== 202) throw new Error(`magic-link status ${r.status}`);
  const sent = h.mailer.sent.slice(before).find((s) => s.email === email.toLowerCase());
  if (!sent) throw new Error(`no magic link captured for ${email}`);
  const token = new URL(sent.link).searchParams.get("token")!;
  const consume = await h.app.request(`/v1/auth/consume?token=${encodeURIComponent(token)}`);
  if (consume.status !== 302) throw new Error(`consume status ${consume.status}`);
  const loc = consume.headers.get("Location")!;
  const session = decodeURIComponent(loc.split("#hunt_session=")[1]);
  const me = await req(h.app, "GET", "/v1/me", { token: session });
  if (me.status !== 200) throw new Error(`me status ${me.status}`);
  return { session, userId: me.json.id };
}

export async function adminCreateEvent(
  h: Harness,
  over: Record<string, unknown> = {},
): Promise<{ id: string; slug: string }> {
  const now = Date.now();
  const r = await req(h.app, "POST", "/v1/admin/events", {
    admin: true,
    body: {
      slug: `ev-${Math.random().toString(36).slice(2, 9)}`,
      title: "Test Hunt",
      district: "Bazaar",
      starts_at: now - 60_000,
      ends_at: now + 60 * 60_000,
      pool_cap_cents: 10_000,
      ...over,
    },
  });
  if (r.status !== 201) throw new Error(`create event ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}

export async function adminSeedPrize(
  h: Harness,
  eventId: string,
  prize: Record<string, unknown>,
): Promise<void> {
  const r = await req(h.app, "POST", `/v1/admin/events/${eventId}/prizes:bulk`, {
    admin: true,
    body: { prizes: [prize] },
  });
  if (r.status !== 201) throw new Error(`seed prize ${r.status}: ${JSON.stringify(r.json)}`);
}

/** Force an event live in the DB (ticker transitions are tested in slice 6). */
export function forceLive(h: Harness, eventId: string): void {
  h.db.query("UPDATE events SET state = 'live' WHERE id = ?").run(eventId);
}
