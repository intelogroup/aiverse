/**
 * Slice 8 — admin backup / restore pair (SPEC §2 backups, audit M6).
 *
 * Proves: admin auth (constant-time path) refuses missing/wrong tokens;
 * export is a consistent SQLite snapshot whose sha256 + counts headers
 * match the bytes; restore validates before it touches the live DB
 * (corrupt/truncated uploads refused with the original DB intact and
 * still serving); the downgrade-to-empty guard refuses an empty
 * snapshot over a real DB unless forced (and then the .bak is kept);
 * and the full round trip — seed → export → wipe → restore — keeps
 * codes decryptable and claim exactly-once intact, with the SAME app
 * object serving before and after the swap (connection recycle).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN,
  adminCreateEvent,
  adminSeedPrize,
  forceLive,
  makeHarness,
  makeUser,
  req,
  type Harness,
} from "./helpers";
import { tickOnce } from "../src/ticker";
import { RateLimiter } from "../src/claims";

/** Claims in these tests are back-to-back; the production limiter
 *  (1 attempt / 2 s / user) and the speed check are slice-5 concerns.
 *  A permissive limiter + a fresh user per claim keeps slice 8 about
 *  backup/restore, not pacing. */
const NO_LIMIT = () => new RateLimiter(0, 100_000, 100_000);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hunt-backup-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function backupBytes(h: Harness): Promise<{ bytes: Buffer; headers: Headers }> {
  const res = await h.app.request("/v1/admin/backup", {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  expect(res.status).toBe(200);
  return { bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

async function restoreBytes(
  h: Harness,
  bytes: Uint8Array,
  opts: { force?: boolean; token?: string | null } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/vnd.sqlite3" };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? ADMIN}`;
  const res = await h.app.request(`/v1/admin/restore${opts.force ? "?force=1" : ""}`, {
    method: "POST",
    headers,
    body: bytes as BodyInit,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

/** Seed one live event with `n` prizes at distinct spots; returns ids + codes. */
async function seedEvent(
  h: Harness,
  n: number,
): Promise<{ eventId: string; slug: string; codes: string[] }> {
  const ev = await adminCreateEvent(h);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = `CODE-${i}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    codes.push(code);
    await adminSeedPrize(h, ev.id, {
      label_public: `prize ${i}`,
      kind: "gift_code",
      face_value_cents: 100,
      x: 100 * (i + 1),
      y: 0,
      z: 100 * (i + 1),
      code,
    });
  }
  forceLive(h, ev.id);
  return { eventId: ev.id, slug: ev.slug, codes };
}

async function claimAt(
  h: Harness,
  session: string,
  eventId: string,
  i: number,
): Promise<{ status: number; json: any }> {
  return req(h.app, "POST", "/v1/claims", {
    token: session,
    body: {
      event_id: eventId,
      body_id: "remy",
      position: { x: 100 * (i + 1), y: 0, z: 100 * (i + 1) },
      client_ts: Date.now(),
    },
  });
}

describe("slice 8 — backup/restore auth", () => {
  test("no token and wrong token are refused on all three endpoints", async () => {
    const h = makeHarness(join(tempDir(), "hunt.db"));
    for (const token of [null, "wrong-token", "test-admin-token-123", "test-admin-token-12345"]) {
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const b = await h.app.request("/v1/admin/backup", { headers });
      expect(b.status).toBe(401);
      const r = await restoreBytes(h, new Uint8Array([1, 2, 3]), { token });
      expect(r.status).toBe(401);
      const rf = await req(h.app, "POST", "/v1/admin/restore-from", {
        body: { source_base_url: "http://127.0.0.1:1" },
        ...(token ? { token } : {}),
      } as any);
      expect(rf.status).toBe(401);
    }
    // Session (non-admin) tokens do not open the pair either.
    const u = await makeUser(h, "hunter@example.com");
    const b = await h.app.request("/v1/admin/backup", {
      headers: { Authorization: `Bearer ${u.session}` },
    });
    expect(b.status).toBe(401);
  });
});

describe("slice 8 — backup export", () => {
  test("snapshot bytes, sha256 header and count headers agree", async () => {
    const dir = tempDir();
    const h = makeHarness(join(dir, "hunt.db"));
    const { eventId, codes } = await seedEvent(h, 3);
    const u = await makeUser(h, "winner@example.com");
    const win = await claimAt(h, u.session, eventId, 0);
    expect(win.json.result).toBe("won");
    expect(win.json.code).toBe(codes[0]);

    const { bytes, headers } = await backupBytes(h);
    expect(headers.get("content-type")).toContain("application/vnd.sqlite3");
    expect(headers.get("x-hunt-snapshot-sha256")).toBe(sha256(bytes));
    expect(Number(headers.get("x-hunt-count-prizes"))).toBe(3);
    expect(Number(headers.get("x-hunt-count-events"))).toBe(1);
    expect(Number(headers.get("x-hunt-count-users"))).toBe(1);
    expect(Number(headers.get("x-hunt-count-claims"))).toBe(1);

    // The snapshot is a real, self-consistent SQLite file.
    const file = join(dir, "snap.db");
    writeFileSync(file, bytes);
    const ro = new Database(file, { readonly: true });
    const ic = ro.query("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(ic.integrity_check).toBe("ok");
    const claimed = ro
      .query("SELECT COUNT(*) AS n FROM prizes WHERE state = 'claimed'")
      .get() as { n: number };
    expect(claimed.n).toBe(1);
    ro.close();
    // Custody: no plaintext code anywhere in the snapshot bytes.
    expect(bytes.includes(Buffer.from(codes[0]))).toBe(false);
  });

  test("export stays consistent while writes are in flight", async () => {
    const dir = tempDir();
    const path = join(dir, "hunt.db");
    const h = makeHarness(path);
    const { eventId } = await seedEvent(h, 6);
    const u = await makeUser(h, "busy@example.com");

    // Interleave claims and backups; every snapshot must be internally
    // consistent: won attempts == claimed prizes inside the snapshot.
    // (A fresh user per claim — pacing checks are slice-5 concerns.)
    for (let i = 0; i < 3; i++) {
      const hunter = await makeUser(h, `busy-${i}@example.com`);
      const r = await claimAt(h, hunter.session, eventId, i);
      expect(r.json.result).toBe("won");
      const { bytes } = await backupBytes(h);
      const f = join(dir, `snap-${i}.db`);
      writeFileSync(f, bytes);
      const ro = new Database(f, { readonly: true });
      const won = ro
        .query("SELECT COUNT(*) AS n FROM claim_attempts WHERE verdict = 'won'")
        .get() as { n: number };
      const claimed = ro
        .query("SELECT COUNT(*) AS n FROM prizes WHERE state = 'claimed'")
        .get() as { n: number };
      expect(won.n).toBe(claimed.n);
      expect(won.n).toBe(i + 1);
      ro.close();
    }

    // A writer in ANOTHER PROCESS holding BEGIN IMMEDIATE does not
    // corrupt or fail the export (busy_timeout rides out the hold).
    // (A same-process second connection would deadlock the test: the
    // export's busy-wait is synchronous and would starve the timer
    // that commits. In production the only writers are this process's
    // own microsecond claim transactions.)
    const writer = join(dir, "writer.ts");
    writeFileSync(
      writer,
      `import { Database } from "bun:sqlite";
       const db = new Database(process.argv[2]);
       db.exec("BEGIN IMMEDIATE");
       db.query("INSERT INTO hunt_users (id, email, display_name, created_at, status) VALUES ('held-user','held@example.com','Held',1,'active')").run();
       Bun.sleepSync(400);
       db.exec("COMMIT");
       db.close();`,
    );
    const proc = Bun.spawn(["bun", writer, path], { stdout: "ignore", stderr: "inherit" });
    await new Promise((r) => setTimeout(r, 100)); // writer holds the lock
    const { bytes } = await backupBytes(h);
    await proc.exited;
    const f = join(dir, "snap-held.db");
    writeFileSync(f, bytes);
    const ro = new Database(f, { readonly: true });
    const ic = ro.query("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(ic.integrity_check).toBe("ok");
    ro.close();
    // Once the writer has committed, the next export sees its row.
    const after = await backupBytes(h);
    const f2 = join(dir, "snap-after.db");
    writeFileSync(f2, after.bytes);
    const ro2 = new Database(f2, { readonly: true });
    const held = ro2
      .query("SELECT COUNT(*) AS n FROM hunt_users WHERE id = 'held-user'")
      .get() as { n: number };
    expect(held.n).toBe(1);
    ro2.close();
  });
});

describe("slice 8 — restore validation (live DB untouched)", () => {
  test("corrupt upload is refused and the original DB keeps serving", async () => {
    const dir = tempDir();
    const h = makeHarness(join(dir, "hunt.db"));
    const { eventId, codes } = await seedEvent(h, 2);

    const garbage = Buffer.from("this is not a sqlite database at all, just text......".repeat(20));
    const r = await restoreBytes(h, garbage);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_snapshot");

    const events = await req(h.app, "GET", "/v1/events");
    expect(events.status).toBe(200);
    expect(events.json.events.length).toBe(1);
    const u = await makeUser(h, "after@example.com");
    const win = await claimAt(h, u.session, eventId, 1);
    expect(win.json.result).toBe("won");
    expect(win.json.code).toBe(codes[1]);
  });

  test("truncated upload is refused and the original DB keeps serving", async () => {
    const dir = tempDir();
    const h = makeHarness(join(dir, "hunt.db"));
    const { slug } = await seedEvent(h, 2);
    const { bytes } = await backupBytes(h);

    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
    const r = await restoreBytes(h, truncated);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_snapshot");

    const state = await req(h.app, "GET", `/v1/events/${slug}/state`);
    expect(state.json.prizes_total).toBe(2);
  });

  test("empty-body and oversized uploads are refused", async () => {
    const h = makeHarness(join(tempDir(), "hunt.db"));
    const empty = await restoreBytes(h, new Uint8Array(0));
    expect(empty.status).toBe(400);
    const big = await h.app.request("/v1/admin/restore", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/vnd.sqlite3" },
      body: new Uint8Array(65 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
  });

  test("restore into a :memory: DB is refused by design", async () => {
    const src = makeHarness(join(tempDir(), "hunt.db"));
    await seedEvent(src, 1);
    const { bytes } = await backupBytes(src);
    const mem = makeHarness(":memory:");
    const r = await restoreBytes(mem, bytes);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("restore_unsupported_memory");
  });
});

describe("slice 8 — downgrade-to-empty guard", () => {
  test("an empty snapshot cannot overwrite a real DB without force; with force the .bak is kept", async () => {
    const dirA = tempDir();
    const a = makeHarness(join(dirA, "hunt.db"));
    const { codes } = await seedEvent(a, 2);
    await makeUser(a, "someone@example.com");

    const emptyH = makeHarness(join(tempDir(), "hunt.db")); // auto-created empty schema
    const { bytes: emptyBytes } = await backupBytes(emptyH);

    const refused = await restoreBytes(a, emptyBytes);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("restore_would_empty");
    // Untouched:
    expect(
      (a.db.query("SELECT COUNT(*) AS n FROM prizes").get() as { n: number }).n,
    ).toBe(2);

    const forced = await restoreBytes(a, emptyBytes, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.json.after.prizes).toBe(0);
    const baks = readdirSync(dirA).filter((f) => f.includes(".bak-"));
    expect(baks.length).toBe(1);
    // The .bak IS the original DB — its prizes (and their custody) survive.
    const bakDb = new Database(join(dirA, baks[0]), { readonly: true });
    expect(
      (bakDb.query("SELECT COUNT(*) AS n FROM prizes").get() as { n: number }).n,
    ).toBe(2);
    bakDb.close();
    expect(codes.length).toBe(2);
  });

  test("restoring over an auto-created empty DB (the VA case) needs no force", async () => {
    const src = makeHarness(join(tempDir(), "hunt.db"));
    await seedEvent(src, 2);
    const { bytes } = await backupBytes(src);

    const va = makeHarness(join(tempDir(), "hunt.db")); // booted on empty disk
    const r = await restoreBytes(va, bytes);
    expect(r.status).toBe(200);
    expect(r.json.before.prizes).toBe(0);
    expect(r.json.after.prizes).toBe(2);
  });
});

describe("slice 8 — full round trip", () => {
  test("seed → export → wipe → restore: codes decrypt, exactly-once holds, ticker runs on the new handle", async () => {
    const dirA = tempDir();
    const a = makeHarness(join(dirA, "hunt.db"), NO_LIMIT());
    const { eventId, slug, codes } = await seedEvent(a, 3);
    const winner = await makeUser(a, "winner@example.com");
    const win = await claimAt(a, winner.session, eventId, 0);
    expect(win.json.result).toBe("won");

    // A second event, scheduled but not yet in its window at backup
    // time — after the restore, the ticker (a db consumer outside the
    // HTTP handlers) must transition it on the NEW handle.
    const soon = Date.now() + 60_000;
    const ev2 = await adminCreateEvent(a, {
      slug: "second-hunt",
      starts_at: soon,
      ends_at: soon + 3_600_000,
    });
    const sched = await req(a.app, "POST", `/v1/admin/events/${ev2.id}/schedule`, { admin: true });
    expect(sched.status).toBe(200);

    const { bytes, headers } = await backupBytes(a);
    expect(headers.get("x-hunt-snapshot-sha256")).toBe(sha256(bytes));

    // Wipe: a brand-new DB on a fresh file, SAME custody key (the key is
    // env, not data — a restore onto a different key is a different world).
    const dirB = tempDir();
    const b = makeHarness(join(dirB, "hunt.db"), NO_LIMIT(), a.codeKey);
    const before = await req(b.app, "GET", "/v1/events");
    expect(before.json.events.length).toBe(0);

    const r = await restoreBytes(b, bytes);
    expect(r.status).toBe(200);
    expect(r.json.after).toMatchObject({ users: 1, events: 2, prizes: 3, claims: 1 });
    expect(existsSync(join(dirB, r.json.bak))).toBe(true);

    // The SAME app object serves the restored world:
    const events = await req(b.app, "GET", "/v1/events");
    expect(events.json.events.map((e: any) => e.slug)).toContain(slug);
    const slugs = b.db.query("SELECT slug FROM events ORDER BY slug").all() as { slug: string }[];
    expect(slugs.map((s) => s.slug)).toEqual([slug, "second-hunt"].sort());

    // The winner's session (carried inside the snapshot) still resolves,
    // and the win re-reads with the code decrypting to the original.
    const wins = await req(b.app, "GET", "/v1/me/wins", { token: winner.session });
    expect(wins.status).toBe(200);
    expect(wins.json.wins.length).toBe(1);
    expect(wins.json.wins[0].code).toBe(codes[0]);

    // Exactly-once still holds on the restored DB: the taken spot
    // refuses a second winner; an untouched spot still pays out; a
    // 10-way race on the last spot yields exactly one winner.
    const late1 = await makeUser(b, "late1@example.com");
    const again = await claimAt(b, late1.session, eventId, 0);
    expect(again.json.result).toBe("already_claimed");
    const late2 = await makeUser(b, "late2@example.com");
    const second = await claimAt(b, late2.session, eventId, 1);
    expect(second.json.result).toBe("won");
    expect(second.json.code).toBe(codes[1]);
    const racers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makeUser(b, `racer-${i}@example.com`)),
    );
    const race = await Promise.all(racers.map((u) => claimAt(b, u.session, eventId, 2)));
    expect(race.filter((x) => x.json.result === "won").length).toBe(1);
    expect(race.find((x) => x.json.result === "won")!.json.code).toBe(codes[2]);

    // The ticker transitions the restored scheduled event on the new
    // handle (its window, future at backup time, is entered by the
    // tick's clock) and the hunt_start announcement lands in the
    // restored DB.
    tickOnce(b.db, soon + 1000);
    const row = b.db.query("SELECT state FROM events WHERE id = ?").get(ev2.id) as {
      state: string;
    };
    expect(row.state).toBe("live");
    const ann = b.db
      .query("SELECT COUNT(*) AS n FROM announcements WHERE event_id = ? AND type = 'hunt_start'")
      .get(ev2.id) as { n: number };
    expect(ann.n).toBe(1);
  });

  test("restore-from: the receiving gateway fetches with its own admin token", async () => {
    const dirA = tempDir();
    const a = makeHarness(join(dirA, "hunt.db"));
    const { eventId, codes } = await seedEvent(a, 2);
    const server = Bun.serve({ port: 0, fetch: a.app.fetch });
    try {
      const dirB = tempDir();
      const b = makeHarness(join(dirB, "hunt.db"), undefined, a.codeKey);
      const r = await req(b.app, "POST", "/v1/admin/restore-from", {
        admin: true,
        body: { source_base_url: `http://127.0.0.1:${server.port}` },
      });
      expect(r.status).toBe(200);
      expect(r.json.after).toMatchObject({ events: 1, prizes: 2 });
      const u = await makeUser(b, "fetcher@example.com");
      const win = await claimAt(b, u.session, eventId, 0);
      expect(win.json.result).toBe("won");
      expect(win.json.code).toBe(codes[0]);
    } finally {
      server.stop(true);
    }
  });

  test("restore-from refuses a source whose checksum header lies", async () => {
    const src = makeHarness(join(tempDir(), "hunt.db"));
    await seedEvent(src, 1);
    const { bytes } = await backupBytes(src);
    const liar = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(bytes as BodyInit, {
          headers: {
            "Content-Type": "application/vnd.sqlite3",
            "X-Hunt-Snapshot-Sha256": "0".repeat(64),
          },
        }),
    });
    try {
      const b = makeHarness(join(tempDir(), "hunt.db"));
      const { eventId } = await seedEvent(b, 1);
      const r = await req(b.app, "POST", "/v1/admin/restore-from", {
        admin: true,
        body: { source_base_url: `http://127.0.0.1:${liar.port}` },
      });
      expect(r.status).toBe(502);
      expect(r.json.error).toBe("source_checksum_mismatch");
      // Untouched:
      const state = await req(b.app, "GET", "/v1/events");
      expect(state.json.events.length).toBe(1);
      expect(eventId).toBeTruthy();
    } finally {
      liar.stop(true);
    }
  });
});
