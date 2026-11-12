import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app";
import { ResendMailer, type Mailer } from "../src/mailer";
import {
  adminCreateEvent,
  adminSeedPrize,
  forceLive,
  makeHarness,
  makeUser,
  req,
  type Harness,
} from "./helpers";

const SPOT = { x: 10, y: 0.2, z: 10 };

async function liveEventWithPrize(h: Harness, code = "WINNER-CODE-1") {
  const ev = await adminCreateEvent(h);
  await adminSeedPrize(h, ev.id, {
    label_public: "a $10 gift code",
    kind: "gift_code",
    face_value_cents: 1000,
    ...SPOT,
    code,
  });
  forceLive(h, ev.id);
  return ev;
}

const claimBody = (eventId: string, pos = SPOT) => ({
  event_id: eventId,
  body_id: "remy",
  position: pos,
  client_ts: Date.now(),
});

function emailAudit(h: Harness, action: string, userId: string) {
  return h.db
    .query("SELECT detail_json FROM audit_log WHERE action = ? AND subject = ?")
    .all(action, userId) as { detail_json: string }[];
}

describe("slice 9 — claim-code email", () => {
  test("a win emails the code to the winner exactly once, and audits email_sent", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const winner = await makeUser(h, "winner@example.com");
    const r = await req(h.app, "POST", "/v1/claims", {
      token: winner.session,
      body: claimBody(ev.id),
    });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("won");
    expect(r.json.code).toBe("WINNER-CODE-1");

    expect(h.mailer.sentClaimCodes).toHaveLength(1);
    expect(h.mailer.sentClaimCodes[0]).toEqual({
      email: "winner@example.com",
      code: "WINNER-CODE-1",
      label: "a $10 gift code",
      kind: "gift_code",
    });
    const sent = emailAudit(h, "email_sent", winner.userId);
    expect(sent).toHaveLength(1);
    expect(sent[0].detail_json).toContain("a $10 gift code");
    // The audit trail records the delivery, never the code itself.
    expect(sent[0].detail_json).not.toContain("WINNER-CODE-1");
    expect(emailAudit(h, "email_failed", winner.userId)).toHaveLength(0);
  });

  test("a win through the positions ping (continuous check) emails too", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h, "PING-CODE-9");
    const u = await makeUser(h, "arriver@example.com");
    const win = await req(h.app, "POST", "/v1/positions", {
      token: u.session,
      body: claimBody(ev.id),
    });
    expect(win.json.result).toBe("won");
    expect(h.mailer.sentClaimCodes).toHaveLength(1);
    expect(h.mailer.sentClaimCodes[0].email).toBe("arriver@example.com");
    expect(h.mailer.sentClaimCodes[0].code).toBe("PING-CODE-9");
  });

  test("losses send nothing: no_prize_in_radius and already_claimed stay silent", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const loser = await makeUser(h, "loser@example.com");
    const far = await req(h.app, "POST", "/v1/claims", {
      token: loser.session,
      body: claimBody(ev.id, { x: -100, y: 0, z: -100 }),
    });
    expect(far.json.result).toBe("no_prize_in_radius");
    expect(h.mailer.sentClaimCodes).toHaveLength(0);
    expect(emailAudit(h, "email_sent", loser.userId)).toHaveLength(0);
    expect(emailAudit(h, "email_failed", loser.userId)).toHaveLength(0);

    // The winner's single email is not repeated for the runner-up.
    const a = await makeUser(h, "a@example.com");
    await req(h.app, "POST", "/v1/claims", { token: a.session, body: claimBody(ev.id) });
    expect(h.mailer.sentClaimCodes).toHaveLength(1);
    const b = await makeUser(h, "b@example.com");
    const second = await req(h.app, "POST", "/v1/claims", {
      token: b.session,
      body: claimBody(ev.id),
    });
    expect(second.json.result).toBe("already_claimed");
    expect(h.mailer.sentClaimCodes).toHaveLength(1);
    expect(emailAudit(h, "email_sent", b.userId)).toHaveLength(0);
  });

  test("a throwing mailer never fails the claim; the failure is audited", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const winner = await makeUser(h, "winner@example.com");
    const throwing: Mailer = {
      sendMagicLink: async () => {},
      sendClaimCode: async () => {
        throw new Error("resend is down");
      },
    };
    const app2 = buildApp({
      db: h.dbSlot.db,
      dbSlot: h.dbSlot,
      cfg: h.cfg,
      mailer: throwing,
      codeKey: h.codeKey,
    });
    const r = await req(app2, "POST", "/v1/claims", {
      token: winner.session,
      body: claimBody(ev.id),
    });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("won");
    expect(r.json.code).toBe("WINNER-CODE-1");
    const prize = h.db
      .query("SELECT state, claimed_by_user_id FROM prizes WHERE event_id = ?")
      .get(ev.id) as { state: string; claimed_by_user_id: string };
    expect(prize.state).toBe("claimed");
    expect(prize.claimed_by_user_id).toBe(winner.userId);
    const failed = emailAudit(h, "email_failed", winner.userId);
    expect(failed).toHaveLength(1);
    expect(failed[0].detail_json).toContain("resend is down");
    expect(emailAudit(h, "email_sent", winner.userId)).toHaveLength(0);
  });

  test("ResendMailer builds the claim-code payload (stubbed fetch)", async () => {
    const calls: { url: string; init: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const m = new ResendMailer("key-123", "AIVerse <noreply@damhall.com>");
      await m.sendClaimCode("winner@example.com", {
        code: "CODE-9",
        label: "a $10 gift code",
        kind: "gift_code",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer key-123");
    const body = JSON.parse(calls[0].init.body);
    expect(body.from).toBe("AIVerse <noreply@damhall.com>");
    expect(body.to).toEqual(["winner@example.com"]);
    expect(body.subject).toBe("Your AIVerse hunt prize code");
    expect(body.text).toContain("CODE-9");
    expect(body.text).toContain("a $10 gift code");
  });

  test("ResendMailer rejects on a non-OK Resend response", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 422 })) as unknown as typeof fetch;
    try {
      const m = new ResendMailer("key-123", "AIVerse <noreply@damhall.com>");
      await expect(
        m.sendClaimCode("winner@example.com", { code: "C", label: "L", kind: "gift_code" }),
      ).rejects.toThrow("resend send failed: 422");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
