/**
 * Slice 7 — PayPal Payouts (Phase 2 cash rail, money amendment §§3/6/7).
 *
 * EVERYTHING is mocked: the PayPal transport is an injected fake, so the
 * suite makes zero network calls and needs no credentials. What is
 * proven here: the config gate, token exchange + caching, the batch
 * request shape, verified-address-only by construction, idempotency
 * (same win → same sender_batch_id → no double-pay path), status
 * mapping, the exactly-once 1099 accumulation across poll + webhook,
 * and webhook signature accept/reject.
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { loadConfig, type HuntConfig } from "../src/config";
import { LogMailer } from "../src/mailer";
import { randomCodeKey } from "../src/custody";
import { buildApp } from "../src/app";
import { PaypalClient, type PaypalFetch, type PaypalHttpResponse } from "../src/paypal";
import {
  mapPaypalItemStatus,
  meetsTaxThreshold,
  senderBatchIdFor,
  yearTotalCents,
  TAX_REPORT_THRESHOLD_CENTS,
} from "../src/payouts";
import { ADMIN, adminCreateEvent, adminSeedPrize, makeUser, req, type Harness } from "./helpers";

// ---------------------------------------------------------------- fake

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

class FakePaypal {
  calls: RecordedCall[] = [];
  itemStatus = "PENDING";
  verifyStatus: "SUCCESS" | "FAILURE" = "SUCCESS";
  failNextPayoutPost: "network" | "http" | null = null;
  failToken = false;
  private items = new Map<string, any>();
  private batches = new Map<string, any>();
  private tokenSeq = 0;

  fetch: PaypalFetch = async (url, init): Promise<PaypalHttpResponse> => {
    this.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith("/v1/oauth2/token")) {
      if (this.failToken) {
        return { status: 401, json: { error: "invalid_client", error_description: "bad creds" } };
      }
      this.tokenSeq += 1;
      return {
        status: 200,
        json: { access_token: `tok-${this.tokenSeq}`, expires_in: 3600, token_type: "Bearer" },
      };
    }
    if (init.method === "POST" && url.endsWith("/v1/payments/payouts")) {
      if (this.failNextPayoutPost === "network") {
        this.failNextPayoutPost = null;
        throw new Error("socket hang up");
      }
      if (this.failNextPayoutPost === "http") {
        this.failNextPayoutPost = null;
        return { status: 422, json: { name: "VALIDATION_ERROR", message: "batch rejected" } };
      }
      const body = JSON.parse(init.body!);
      const sb = body.sender_batch_header;
      const item0 = body.items[0];
      const batchId = `BATCH-${sb.sender_batch_id}`;
      const itemId = `ITEM-${item0.sender_item_id}`;
      const item = {
        payout_item_id: itemId,
        payout_batch_id: batchId,
        transaction_status: this.itemStatus,
        transaction_id: this.itemStatus === "SUCCESS" ? "TXN-1" : undefined,
        sender_item_id: item0.sender_item_id,
      };
      this.items.set(itemId, item);
      const batch = {
        batch_header: {
          payout_batch_id: batchId,
          batch_status: "PENDING",
          sender_batch_header: { sender_batch_id: sb.sender_batch_id },
        },
        items: [item],
      };
      this.batches.set(batchId, batch);
      return { status: 201, json: batch };
    }
    const itemMatch = url.match(/\/v1\/payments\/payouts\/items\/(.+)$/);
    if (init.method === "GET" && itemMatch) {
      const item = this.items.get(decodeURIComponent(itemMatch[1]));
      if (!item) return { status: 404, json: { name: "RESOURCE_NOT_FOUND", message: "no item" } };
      return { status: 200, json: item };
    }
    const batchMatch = url.match(/\/v1\/payments\/payouts\/([^/]+)$/);
    if (init.method === "GET" && batchMatch) {
      const batch = this.batches.get(decodeURIComponent(batchMatch[1]));
      if (!batch) return { status: 404, json: { name: "RESOURCE_NOT_FOUND", message: "no batch" } };
      return { status: 200, json: batch };
    }
    if (init.method === "POST" && url.endsWith("/v1/notifications/verify-webhook-signature")) {
      return { status: 200, json: { verification_status: this.verifyStatus } };
    }
    throw new Error(`FakePaypal: unhandled ${init.method} ${url}`);
  };

  payoutPosts(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/payments/payouts"));
  }
  tokenPosts(): RecordedCall[] {
    return this.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"));
  }
  verifyPosts(): RecordedCall[] {
    return this.calls.filter((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"));
  }
  setItemStatus(itemId: string, status: string, transactionId?: string): void {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no fake item ${itemId}`);
    item.transaction_status = status;
    if (transactionId) item.transaction_id = transactionId;
  }
}

// ---------------------------------------------------------------- harness

const PP_ENV = {
  PAYPAL_MODE: "sandbox",
  PAYPAL_CLIENT_ID: "cid-test",
  PAYPAL_CLIENT_SECRET: "secret-test",
  PAYPAL_WEBHOOK_ID: "wh-test-1",
};

function paypalCfg(env: Record<string, string | undefined>): HuntConfig {
  return loadConfig({
    NODE_ENV: "test",
    HUNT_PORT: "8799",
    HUNT_ADMIN_TOKEN: ADMIN,
    HUNT_CODE_KEY: randomCodeKey().toString("base64"),
    ...env,
  });
}

function makePayoutHarness(
  fake: FakePaypal,
  envOver: Record<string, string | undefined> = {},
): Harness {
  const db = openDb(":memory:");
  const key = randomCodeKey();
  const cfg = loadConfig({
    NODE_ENV: "test",
    HUNT_PORT: "8799",
    HUNT_ADMIN_TOKEN: ADMIN,
    HUNT_CODE_KEY: key.toString("base64"),
    HUNT_PUBLIC_BASE: "http://localhost:8799",
    HUNT_CONSOLE_URL: "http://localhost:5173",
    ...PP_ENV,
    ...envOver,
  });
  const mailer = new LogMailer();
  const app = buildApp({ db, cfg, mailer, codeKey: key, paypalFetch: fake.fetch });
  return { db, cfg, mailer, app, codeKey: key };
}

async function claimedPrize(
  h: Harness,
  opts: { userId: string; eventId: string; valueCents: number; code: string },
): Promise<string> {
  await adminSeedPrize(h, opts.eventId, {
    label_public: "cash prize",
    kind: "gift_code",
    face_value_cents: opts.valueCents,
    x: 1,
    y: 0.2,
    z: 1,
    code: opts.code,
  });
  const row = h.db
    .query("SELECT id FROM prizes WHERE event_id = ? AND state = 'seeded' ORDER BY rowid DESC LIMIT 1")
    .get(opts.eventId) as { id: string };
  h.db
    .query("UPDATE prizes SET state = 'claimed', claimed_by_user_id = ?, claimed_at = ? WHERE id = ?")
    .run(opts.userId, Date.now(), row.id);
  return row.id;
}

function setAddress(h: Harness, userId: string, address: string, verified: boolean): void {
  const now = Date.now();
  h.db
    .query(
      "INSERT INTO payout_addresses (user_id, kind, address, verified_at, created_at, updated_at) VALUES (?, 'paypal', ?, ?, ?, ?)",
    )
    .run(userId, address, verified ? now : null, now, now);
}

const WEBHOOK_HEADERS = {
  "Content-Type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/test",
  "paypal-transmission-id": "txm-1",
  "paypal-transmission-sig": "sig-1",
  "paypal-transmission-time": "2026-11-08T21:00:00Z",
};

function postWebhook(h: Harness, event: unknown) {
  return h.app.request("/v1/paypal/webhooks", {
    method: "POST",
    headers: WEBHOOK_HEADERS,
    body: JSON.stringify(event),
  });
}

// ---------------------------------------------------------------- tests

describe("slice 7 — paypal payouts (mocked transport)", () => {
  test("config gate: off by default; sandbox needs creds; bases + override resolve", () => {
    expect(paypalCfg({}).paypal.enabled).toBe(false);
    expect(paypalCfg({}).paypal.mode).toBe("off");
    expect(paypalCfg({ PAYPAL_MODE: "sandbox" }).paypal.enabled).toBe(false);

    const sb = paypalCfg(PP_ENV).paypal;
    expect(sb.enabled).toBe(true);
    expect(sb.apiBase).toBe("https://api-m.sandbox.paypal.com");

    const live = paypalCfg({ ...PP_ENV, PAYPAL_MODE: "live" }).paypal;
    expect(live.apiBase).toBe("https://api-m.paypal.com");

    const over = paypalCfg({ ...PP_ENV, PAYPAL_API_BASE: "http://localhost:9999/" }).paypal;
    expect(over.apiBase).toBe("http://localhost:9999");

    expect(() => paypalCfg({ PAYPAL_MODE: "sideways" })).toThrow(/PAYPAL_MODE/);
    expect(() =>
      paypalCfg({ NODE_ENV: "production", PAYPAL_MODE: "sandbox", HUNT_CODE_KEY: randomCodeKey().toString("base64") }),
    ).toThrow(/PAYPAL_CLIENT_ID/);
  });

  test("module disabled ⇒ service boots clean and the money routes are absent", async () => {
    const { makeHarness } = await import("./helpers");
    const h = makeHarness(); // no PAYPAL_* env at all
    const health = await req(h.app, "GET", "/health");
    expect(health.status).toBe(200);
    const wh = await h.app.request("/v1/paypal/webhooks", { method: "POST", body: "{}" });
    expect(wh.status).toBe(404);
    const pay = await req(h.app, "POST", "/v1/admin/prizes/whatever/payout", { admin: true });
    expect(pay.status).toBe(404);
    const get = await req(h.app, "GET", "/v1/admin/payouts/whatever", { admin: true });
    expect(get.status).toBe(404);
  });

  test("token exchange: shape, caching until near expiry, and secret-free errors", async () => {
    const fake = new FakePaypal();
    const client = new PaypalClient(paypalCfg(PP_ENV).paypal, fake.fetch);
    const t0 = 1_700_000_000_000;

    const tok1 = await client.accessToken(t0);
    expect(tok1).toBe("tok-1");
    const call = fake.tokenPosts()[0];
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(call.body).toBe("grant_type=client_credentials");
    const basic = Buffer.from(call.headers.Authorization.replace("Basic ", ""), "base64").toString();
    expect(basic).toBe("cid-test:secret-test");

    expect(await client.accessToken(t0 + 60_000)).toBe("tok-1");
    expect(fake.tokenPosts().length).toBe(1);

    expect(await client.accessToken(t0 + 3_600_000)).toBe("tok-2");
    expect(fake.tokenPosts().length).toBe(2);

    fake.failToken = true;
    const client2 = new PaypalClient(paypalCfg(PP_ENV).paypal, fake.fetch);
    let message = "";
    try {
      await client2.accessToken(t0);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("401");
    expect(message).not.toContain("secret-test");
    expect(message).not.toContain("tok-");
  });

  test("sender batch id is a pure function of the win", () => {
    expect(senderBatchIdFor("sandbox", "prize-1")).toBe("hunt-sbx-prize-1");
    expect(senderBatchIdFor("sandbox", "prize-1")).toBe(senderBatchIdFor("sandbox", "prize-1"));
    expect(senderBatchIdFor("live", "prize-1")).toBe("hunt-live-prize-1");
    expect(senderBatchIdFor("live", "prize-1")).not.toBe(senderBatchIdFor("sandbox", "prize-1"));
  });

  test("batch create: request shape carries the verified address and true amount", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "winner@example.com");
    const ev = await adminCreateEvent(h);
    const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 2500, code: "C-1" });
    setAddress(h, userId, "winner@example.com", true);

    const r = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
    expect(r.status).toBe(200);
    expect(r.json.payout.status).toBe("pending");
    expect(r.json.payout.mode).toBe("sandbox");
    expect(r.json.payout.recipient).toBe("w•••@example.com"); // masked on the way out
    expect(r.json.payout.batch_id).toBe(`BATCH-hunt-sbx-${prizeId}`);

    const posts = fake.payoutPosts();
    expect(posts.length).toBe(1);
    const body = JSON.parse(posts[0].body!);
    expect(body.sender_batch_header.sender_batch_id).toBe(`hunt-sbx-${prizeId}`);
    expect(body.sender_batch_header.recipient_type).toBe("EMAIL");
    expect(body.items[0].recipient_type).toBe("EMAIL");
    expect(body.items[0].receiver).toBe("winner@example.com");
    expect(body.items[0].amount).toEqual({ value: "25.00", currency: "USD" });
    expect(body.items[0].sender_item_id).toBe(prizeId);
  });

  test("unverified or missing address ⇒ refused BEFORE any PayPal traffic", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "hopeful@example.com");
    const ev = await adminCreateEvent(h);
    const p1 = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 1000, code: "C-2" });

    const noAddr = await req(h.app, "POST", `/v1/admin/prizes/${p1}/payout`, { admin: true });
    expect(noAddr.status).toBe(422);
    expect(noAddr.json.error).toBe("payout_address_unverified");
    expect(fake.calls.length).toBe(0);

    setAddress(h, userId, "hopeful@example.com", false); // present but UNVERIFIED
    const unverified = await req(h.app, "POST", `/v1/admin/prizes/${p1}/payout`, { admin: true });
    expect(unverified.status).toBe(422);
    expect(unverified.json.error).toBe("payout_address_unverified");
    expect(fake.calls.length).toBe(0);
  });

  test("suspended winner is refused; unclaimed prize is refused", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "suspect@example.com");
    const ev = await adminCreateEvent(h);
    const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 1000, code: "C-3" });
    setAddress(h, userId, "suspect@example.com", true);
    h.db.query("UPDATE hunt_users SET status = 'suspended' WHERE id = ?").run(userId);
    const r = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("winner_not_active");
    expect(fake.calls.length).toBe(0);

    await adminSeedPrize(h, ev.id, {
      label_public: "cash prize",
      kind: "gift_code",
      face_value_cents: 500,
      x: 2,
      y: 0.2,
      z: 2,
      code: "C-4",
    });
    const seeded = h.db.query("SELECT id FROM prizes WHERE state = 'seeded' LIMIT 1").get() as { id: string };
    const r2 = await req(h.app, "POST", `/v1/admin/prizes/${seeded.id}/payout`, { admin: true });
    expect(r2.status).toBe(422);
    expect(r2.json.error).toBe("prize_not_claimed");
  });

  test("idempotency: a submitted win never submits twice; an ambiguous submit retries with the identical key", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "steady@example.com");
    const ev = await adminCreateEvent(h);
    const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 4200, code: "C-5" });
    setAddress(h, userId, "steady@example.com", true);

    const first = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
    const second = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.payout.id).toBe(first.json.payout.id);
    expect(fake.payoutPosts().length).toBe(1);

    // Ambiguous failure on a fresh win: network dies mid-submit.
    const ev2 = await adminCreateEvent(h);
    const prize2 = await claimedPrize(h, { userId, eventId: ev2.id, valueCents: 1100, code: "C-6" });
    fake.failNextPayoutPost = "network";
    const attempt1 = await req(h.app, "POST", `/v1/admin/prizes/${prize2}/payout`, { admin: true });
    expect(attempt1.status).toBe(202); // accepted, not known to be submitted
    expect(attempt1.json.payout.status).toBe("created");
    expect(attempt1.json.payout.batch_id).toBeNull();
    const rowAfterFail = h.db.query("SELECT failure FROM payouts WHERE prize_id = ?").get(prize2) as {
      failure: string;
    };
    expect(rowAfterFail.failure).toContain("network_error");

    const attempt2 = await req(h.app, "POST", `/v1/admin/prizes/${prize2}/payout`, { admin: true });
    expect(attempt2.status).toBe(200);
    expect(attempt2.json.payout.batch_id).toBe(`BATCH-hunt-sbx-${prize2}`);
    const posts = fake.payoutPosts().filter((c) => c.body?.includes(prize2));
    expect(posts.length).toBe(2);
    expect(posts[0].body).toBe(posts[1].body); // identical replay — same key, same everything

    // A PayPal-side rejection lands the same way: recorded, still retryable.
    const ev3 = await adminCreateEvent(h);
    const prize3 = await claimedPrize(h, { userId, eventId: ev3.id, valueCents: 900, code: "C-7" });
    fake.failNextPayoutPost = "http";
    const rejected = await req(h.app, "POST", `/v1/admin/prizes/${prize3}/payout`, { admin: true });
    expect(rejected.status).toBe(202);
    expect(rejected.json.payout.status).toBe("created");
    const row3 = h.db.query("SELECT failure FROM payouts WHERE prize_id = ?").get(prize3) as { failure: string };
    expect(row3.failure).toContain("VALIDATION_ERROR");
  });

  test("one payout per verified person per event — but a second event pays", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "double@example.com");
    setAddress(h, userId, "double@example.com", true);
    const ev = await adminCreateEvent(h);
    const pA = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 1500, code: "C-8" });
    const pB = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 1500, code: "C-9" });

    expect((await req(h.app, "POST", `/v1/admin/prizes/${pA}/payout`, { admin: true })).status).toBe(200);
    const second = await req(h.app, "POST", `/v1/admin/prizes/${pB}/payout`, { admin: true });
    expect(second.status).toBe(422);
    expect(second.json.error).toBe("one_payout_per_event");
    expect(fake.payoutPosts().length).toBe(1);

    const ev2 = await adminCreateEvent(h);
    const pC = await claimedPrize(h, { userId, eventId: ev2.id, valueCents: 1500, code: "C-10" });
    expect((await req(h.app, "POST", `/v1/admin/prizes/${pC}/payout`, { admin: true })).status).toBe(200);
    expect(fake.payoutPosts().length).toBe(2);
  });

  test("status mapping covers the PayPal vocabulary", () => {
    expect(mapPaypalItemStatus("SUCCESS")).toBe("success");
    expect(mapPaypalItemStatus("PENDING")).toBe("pending");
    expect(mapPaypalItemStatus("UNCLAIMED")).toBe("unclaimed");
    expect(mapPaypalItemStatus("RETURNED")).toBe("returned");
    expect(mapPaypalItemStatus("REFUNDED")).toBe("returned");
    expect(mapPaypalItemStatus("FAILED")).toBe("failed");
    expect(mapPaypalItemStatus("BLOCKED")).toBe("blocked");
    expect(mapPaypalItemStatus("DENIED")).toBe("denied");
    expect(mapPaypalItemStatus("SOMETHING_NEW")).toBe("unknown");
    expect(mapPaypalItemStatus(null)).toBe("unknown");
    expect(mapPaypalItemStatus(undefined)).toBe("unknown");
  });

  test("SUCCESS accumulates the yearly total exactly once — poll and webhook racing", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "racer@example.com");
    setAddress(h, userId, "racer@example.com", true);
    const ev = await adminCreateEvent(h);
    const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 3000, code: "C-11" });

    const created = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
    const payoutId = created.json.payout.id;
    const itemId = created.json.payout.item_id;
    const year = new Date().getUTCFullYear();
    expect(yearTotalCents(h.db, userId, "sandbox", year)).toBe(0);

    fake.setItemStatus(itemId, "SUCCESS", "TXN-77");
    const wh = await postWebhook(h, {
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_item_id: itemId, transaction_status: "SUCCESS", transaction_id: "TXN-77" },
    });
    expect(wh.status).toBe(200);
    expect(yearTotalCents(h.db, userId, "sandbox", year)).toBe(3000);

    // The poll path observing the same win must not count it again.
    const polled = await req(h.app, "GET", `/v1/admin/payouts/${payoutId}`, { admin: true });
    expect(polled.json.payout.status).toBe("success");
    expect(polled.json.payout.transaction_id).toBe("TXN-77");
    expect(polled.json.payout.paid_at).toBeGreaterThan(0);
    expect(yearTotalCents(h.db, userId, "sandbox", year)).toBe(3000);
    expect(yearTotalCents(h.db, userId, "live", year)).toBe(0); // modes never mix
  });

  test("1099 hook: totals cross the threshold only via SUCCESS money", async () => {
    expect(TAX_REPORT_THRESHOLD_CENTS).toBe(600_00);
    expect(meetsTaxThreshold(599_99)).toBe(false);
    expect(meetsTaxThreshold(600_00)).toBe(true);

    const fake = new FakePaypal();
    fake.itemStatus = "SUCCESS"; // created batches settle immediately
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "bigwin@example.com");
    setAddress(h, userId, "bigwin@example.com", true);
    const year = new Date().getUTCFullYear();

    for (const cents of [400_00, 250_00]) {
      const ev = await adminCreateEvent(h, { pool_cap_cents: 1_000_00 });
      const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: cents, code: `C-${cents}` });
      const r = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
      expect(r.status).toBe(200);
      expect(r.json.payout.status).toBe("success");
    }
    const total = yearTotalCents(h.db, userId, "sandbox", year);
    expect(total).toBe(650_00);
    expect(meetsTaxThreshold(total)).toBe(true);
  });

  test("webhook intake: unconfigured id rejects, bad signature rejects, good signature applies", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "hooked@example.com");
    setAddress(h, userId, "hooked@example.com", true);
    const ev = await adminCreateEvent(h);
    const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 2000, code: "C-12" });
    const created = await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });
    const itemId = created.json.payout.item_id;
    const succeeded = {
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_item_id: itemId, transaction_status: "SUCCESS", transaction_id: "TXN-9" },
    };

    // Bad signature: rejected, payout untouched.
    fake.verifyStatus = "FAILURE";
    const bad = await postWebhook(h, succeeded);
    expect(bad.status).toBe(400);
    const statusAfterBad = h.db.query("SELECT status FROM payouts WHERE id = ?").get(created.json.payout.id) as {
      status: string;
    };
    expect(statusAfterBad.status).toBe("pending");

    // Good signature: applied. Verify call carried the configured id + headers.
    fake.verifyStatus = "SUCCESS";
    const good = await postWebhook(h, succeeded);
    expect(good.status).toBe(200);
    const verifyBody = JSON.parse(fake.verifyPosts().at(-1)!.body!);
    expect(verifyBody.webhook_id).toBe("wh-test-1");
    expect(verifyBody.transmission_id).toBe("txm-1");
    expect(verifyBody.auth_algo).toBe("SHA256withRSA");
    const row = h.db.query("SELECT status, transaction_id FROM payouts WHERE id = ?").get(created.json.payout.id) as {
      status: string;
      transaction_id: string;
    };
    expect(row.status).toBe("success");
    expect(row.transaction_id).toBe("TXN-9");

    // Signed but unrelated / unknown: accepted, ignored, no retries provoked.
    const unrelated = await postWebhook(h, { event_type: "CHECKOUT.ORDER.APPROVED", resource: {} });
    expect(unrelated.status).toBe(200);
    const unknown = await postWebhook(h, {
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_item_id: "ITEM-nope", transaction_status: "SUCCESS" },
    });
    expect(unknown.status).toBe(200);
  });

  test("webhook without a configured webhook id rejects and never calls verify", async () => {
    const fake = new FakePaypal();
    const h = makePayoutHarness(fake, { PAYPAL_WEBHOOK_ID: undefined });
    const res = await postWebhook(h, {
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_item_id: "ITEM-x", transaction_status: "SUCCESS" },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("webhook_id_unconfigured");
    expect(fake.verifyPosts().length).toBe(0);
  });

  test("receipts: a paid win publishes masked address + real status; an unpaid win keeps the Phase 1 shape", async () => {
    const fake = new FakePaypal();
    fake.itemStatus = "SUCCESS";
    const h = makePayoutHarness(fake);
    const { userId } = await makeUser(h, "receipt@example.com");
    setAddress(h, userId, "receipt@example.com", true);
    const ev = await adminCreateEvent(h);
    const prizeId = await claimedPrize(h, { userId, eventId: ev.id, valueCents: 5000, code: "C-13" });
    await req(h.app, "POST", `/v1/admin/prizes/${prizeId}/payout`, { admin: true });

    const r = await req(h.app, "GET", `/v1/admin/events/${ev.id}/receipts`, { admin: true });
    expect(r.status).toBe(200);
    expect(r.json.receipts.length).toBe(1);
    expect(r.json.receipts[0].payout_status).toBe("success");
    expect(r.json.receipts[0].payout_address).toBe("r•••@example.com");
    expect(JSON.stringify(r.json)).not.toContain("receipt@example.com");

    const ev2 = await adminCreateEvent(h);
    await claimedPrize(h, { userId, eventId: ev2.id, valueCents: 500, code: "C-14" });
    const r2 = await req(h.app, "GET", `/v1/admin/events/${ev2.id}/receipts`, { admin: true });
    expect(r2.json.receipts[0].payout_status).toBe("n/a_code_revealed");
    expect(r2.json.receipts[0].payout_address).toBeNull();
  });

  test("schema v2: payouts tables exist and prize uniqueness is a database fact", () => {
    const db = openDb(":memory:");
    const v = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(2);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("payouts");
    expect(tables).toContain("payout_year_totals");

    const uid = "u-1";
    db.query(
      "INSERT INTO hunt_users (id, email, display_name, created_at) VALUES (?, 'a@b.c', 'A', 1)",
    ).run(uid);
    db.query(
      "INSERT INTO events (id, slug, title, district, starts_at, ends_at, pool_cap_cents, claim_radius_m, created_by, created_at) VALUES ('e-1','s','t','Bazaar',0,9,100,1.5,'admin',1)",
    ).run();
    db.query(
      `INSERT INTO prizes (id, event_id, label_public, kind, face_value_cents, x, y, z, code_encrypted, code_nonce, created_at)
       VALUES ('p-1', 'e-1', 'cash', 'gift_code', 100, 0, 0, 0, X'00', X'00', 1)`,
    ).run();
    const insert = () =>
      db
        .query(
          `INSERT INTO payouts (id, prize_id, event_id, user_id, amount_cents, mode, recipient, sender_batch_id, sender_item_id, status, created_at, updated_at)
           VALUES (?, 'p-1', 'e-1', ?, 100, 'sandbox', 'a@b.c', ?, 'p-1', 'created', 1, 1)`,
        )
        .run(crypto.randomUUID(), uid, `hunt-sbx-p-1-${Math.random()}`);
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });
});
