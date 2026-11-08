import { describe, expect, test } from "bun:test";
import { makeHarness, makeUser, req } from "./helpers";

describe("slice 3 — identity", () => {
  test("magic-link → consume → session works end to end", async () => {
    const h = makeHarness();
    const { session, userId } = await makeUser(h, "Hunter@Example.com");
    expect(session.length).toBeGreaterThan(20);
    const me = await req(h.app, "GET", "/v1/me", { token: session });
    expect(me.status).toBe(200);
    expect(me.json.id).toBe(userId);
    expect(me.json.email).toBe("hunter@example.com"); // lowercased
    expect(me.json.display_name).toBe("hunter"); // default: email prefix
  });

  test("raw tokens are absent from the DB (hash-only storage)", async () => {
    const h = makeHarness();
    const { session } = await makeUser(h, "hashes@example.com");
    const rows = h.db.query("SELECT token_hash FROM auth_tokens").all() as { token_hash: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2); // magic + session
    for (const r of rows) {
      expect(r.token_hash).not.toBe(session);
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(session);
  });

  test("magic token reuse fails; expired link fails", async () => {
    const h = makeHarness();
    await req(h.app, "POST", "/v1/auth/magic-link", { body: { email: "reuse@example.com" } });
    const link = h.mailer.sent[0].link;
    const token = new URL(link).searchParams.get("token")!;
    const first = await h.app.request(`/v1/auth/consume?token=${encodeURIComponent(token)}`);
    expect(first.status).toBe(302);
    const second = await h.app.request(`/v1/auth/consume?token=${encodeURIComponent(token)}`);
    expect(second.status).toBe(400);
    // Expire a fresh link by hand, then try it.
    await req(h.app, "POST", "/v1/auth/magic-link", { body: { email: "reuse@example.com" } });
    const token2 = new URL(h.mailer.sent[1].link).searchParams.get("token")!;
    h.db.query("UPDATE auth_tokens SET expires_at = ? WHERE kind = 'magic' AND consumed_at IS NULL").run(1);
    const third = await h.app.request(`/v1/auth/consume?token=${encodeURIComponent(token2)}`);
    expect(third.status).toBe(400);
  });

  test("magic-link endpoint never enumerates accounts (always 202)", async () => {
    const h = makeHarness();
    const bad = await req(h.app, "POST", "/v1/auth/magic-link", { body: { email: "not-an-email" } });
    expect(bad.status).toBe(202);
    expect(h.mailer.sent.length).toBe(0); // malformed addresses send nothing
    const good = await req(h.app, "POST", "/v1/auth/magic-link", { body: { email: "real@example.com" } });
    expect(good.status).toBe(202);
    expect(h.mailer.sent.length).toBe(1);
  });

  test("unauthenticated hunter routes 401; display name is editable", async () => {
    const h = makeHarness();
    expect((await req(h.app, "GET", "/v1/me")).status).toBe(401);
    expect((await req(h.app, "GET", "/v1/me/wins")).status).toBe(401);
    const { session } = await makeUser(h, "names@example.com");
    const patched = await req(h.app, "PATCH", "/v1/me", {
      token: session,
      body: { display_name: "Scout Prime", publicity_opt_out: true },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.display_name).toBe("Scout Prime");
    expect(patched.json.publicity_opt_out).toBe(true);
  });
});
