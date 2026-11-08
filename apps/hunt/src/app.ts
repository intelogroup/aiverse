/**
 * Hunt service HTTP surface (SPEC §9). Base /v1, JSON everywhere.
 * Prize coordinates and other users' emails never appear in any response
 * (invariant I4); claim requests never carry a prize id (§6.1).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Database } from "bun:sqlite";
import type { HuntConfig } from "./config";
import { DEFAULT_CLAIM_RADIUS_M } from "./config";
import type { Mailer } from "./mailer";
import {
  bearerToken,
  consumeMagicLink,
  requestMagicLink,
  userForGatewayOwner,
  userForSession,
  type GatewayIdentity,
} from "./auth";
import { evaluateClaim, listWins, RateLimiter, type ClaimResult } from "./claims";
import { decryptCode, encryptCode } from "./custody";
import {
  auditInsert,
  effectiveState,
  getEventById,
  getEventBySlug,
  ledgerInsert,
  poolSeededTotal,
  prizeCounts,
  type EventRow,
  type UserRow,
} from "./store";
import { newId } from "./tokens";
import { tickOnce } from "./ticker";
import { PaypalClient, PaypalError, type PaypalFetch } from "./paypal";
import {
  PayoutError,
  cancelPayout,
  getPayoutById,
  handlePayoutWebhook,
  initiatePayout,
  maskAddress,
  refreshPayout,
  type PayoutRow,
} from "./payouts";

export type { GatewayIdentity };

/**
 * Injected by the host when embedded (GATEWAY-INTEGRATION §d): verifies a
 * gateway session JWT and returns the owner identity, or null. The hunt
 * app never imports gateway code — the gateway passes a closure over its
 * own session verifier at mount time.
 */
export type VerifyGatewayToken = (token: string) => Promise<GatewayIdentity | null>;

export interface AppDeps {
  db: Database;
  cfg: HuntConfig;
  mailer: Mailer;
  codeKey: Buffer;
  limiter?: RateLimiter;
  /** Primary identity path when mounted inside the gateway. */
  verifyGatewayToken?: VerifyGatewayToken;
  /**
   * Mount option (GATEWAY-INTEGRATION §b.6): when false, the host's CORS
   * layer governs and the hunt app adds none of its own. Default true
   * (standalone posture unchanged).
   */
  cors?: boolean;
  /** Transport override for the PayPal client — tests inject a fake so
   *  the suite never touches the network. Unset = real fetch. */
  paypalFetch?: PaypalFetch;
}

/** Admin/webhook view of a payout: the address is masked everywhere it
 *  leaves the service; the full recipient lives only in the DB row. */
function payoutView(row: PayoutRow) {
  return { ...row, recipient: maskAddress(row.recipient) };
}

interface Vars {
  user: UserRow;
}

const err = (code: string) => ({ error: code });

function claimResponse(c: any, r: ClaimResult, eventSlug: string) {
  switch (r.result) {
    case "won":
      return c.json(
        {
          result: "won",
          prize: { label: r.label, kind: r.kind },
          code: r.code,
          event_slug: eventSlug,
        },
        200,
      );
    case "rate_limited":
      return c.json({ result: "rate_limited", retry_after_s: r.retry_after_s }, 429);
    case "event_not_live":
      return c.json({ result: "event_not_live" }, 409);
    case "suspended_user":
      return c.json({ result: "suspended_user" }, 403);
    default:
      return c.json({ result: r.result }, 200);
  }
}

function parseClaimBody(body: any): { event_id: string; body_id: string; position: { x: number; y: number; z: number }; client_ts: number | null } | null {
  if (!body || typeof body !== "object") return null;
  const p = body.position;
  if (
    typeof body.event_id !== "string" ||
    typeof body.body_id !== "string" ||
    !p ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    !Number.isFinite(p.z)
  ) {
    return null;
  }
  return {
    event_id: body.event_id,
    body_id: body.body_id,
    position: { x: p.x, y: p.y, z: p.z },
    client_ts: Number.isFinite(body.client_ts) ? body.client_ts : null,
  };
}

export function buildApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const { db, cfg, mailer, codeKey } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const app = new Hono<{ Variables: Vars }>();
  // Phase 2 cash rail: the client exists only when the config gate is
  // open (PAYPAL_MODE + credentials). Disabled ⇒ no client, no routes —
  // the money surface is absent, not merely guarded (bazaar idiom).
  const paypal = cfg.paypal.enabled ? new PaypalClient(cfg.paypal, deps.paypalFetch) : null;

  if (deps.cors !== false) {
    app.use(
      "*",
      cors({
        origin: (origin) => (cfg.corsOrigins.includes(origin) ? origin : cfg.corsOrigins[0]),
        allowMethods: ["GET", "POST", "PATCH", "PUT"],
        allowHeaders: ["Authorization", "Content-Type", "If-None-Match"],
        exposeHeaders: ["ETag"],
      }),
    );
  }

  const requireUser = async (c: any, next: any) => {
    const token = bearerToken(c.req.header("Authorization"));
    let user: UserRow | null = null;
    // Primary path (gateway embed, GATEWAY-INTEGRATION §d): a gateway
    // owner JWT — three dot-separated segments, unlike the opaque hunt
    // session tokens — is verified through the injected verifier and
    // resolves (or creates/adopts) the hunt user by gateway_owner_id.
    if (token && deps.verifyGatewayToken && token.split(".").length === 3) {
      const identity = await deps.verifyGatewayToken(token).catch(() => null);
      if (identity) user = userForGatewayOwner(db, identity, Date.now());
    }
    // Fallback: hunt's own magic-link session (§4), unchanged.
    if (!user && token) user = userForSession(db, token, Date.now());
    if (!user) return c.json(err("unauthorized"), 401);
    c.set("user", user);
    await next();
  };
  const requireAdmin = async (c: any, next: any) => {
    const token = bearerToken(c.req.header("Authorization"));
    if (!token || token !== cfg.adminToken) return c.json(err("unauthorized"), 401);
    await next();
  };

  // ---------- public ----------
  app.get("/health", (c) =>
    c.json({ ok: true, version: "0.1.0", server_time: Date.now() }),
  );

  app.get("/v1/events", (c) => {
    const now = Date.now();
    const rows = db
      .query("SELECT * FROM events WHERE state IN ('scheduled','live','paused') ORDER BY starts_at")
      .all() as unknown as EventRow[];
    return c.json({
      events: rows.map((ev) => ({
        slug: ev.slug,
        title: ev.title,
        district: ev.district,
        starts_at: ev.starts_at,
        ends_at: ev.ends_at,
        state: effectiveState(ev, now),
        tier: ev.tier,
      })),
    });
  });

  app.get("/v1/events/:slug/state", (c) => {
    const ev = getEventBySlug(db, c.req.param("slug"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const now = Date.now();
    const { total, claimed } = prizeCounts(db, ev.id);
    const body = {
      state: effectiveState(ev, now),
      starts_at: ev.starts_at,
      ends_at: ev.ends_at,
      prizes_total: total,
      prizes_claimed: claimed,
      prizes_remaining: total - claimed,
      server_time: now,
    };
    const etag = `W/"${Bun.hash(JSON.stringify(body)).toString(16)}"`;
    if (c.req.header("If-None-Match") === etag) {
      return c.body(null, 304, { ETag: etag, "Cache-Control": "public, max-age=2" });
    }
    return c.json(body, 200, { ETag: etag, "Cache-Control": "public, max-age=2" });
  });

  // ---------- auth / identity ----------
  app.post("/v1/auth/magic-link", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body?.email) {
      await requestMagicLink(db, mailer, cfg.publicBase, String(body.email), Date.now());
    }
    return c.json({ ok: true }, 202); // always — no account enumeration
  });

  app.get("/v1/auth/consume", (c) => {
    const token = c.req.query("token") ?? "";
    const session = consumeMagicLink(db, token, Date.now());
    if (!session) return c.json(err("invalid_or_expired_link"), 400);
    // Session token travels in the URL fragment — never in server logs.
    return c.redirect(`${cfg.consoleUrl}/#hunt_session=${encodeURIComponent(session)}`, 302);
  });

  // ---------- hunter ----------
  app.get("/v1/me", requireUser, (c) => {
    const u = c.get("user");
    return c.json({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      publicity_opt_out: u.publicity_opt_out === 1,
    });
  });

  app.patch("/v1/me", requireUser, async (c) => {
    const u = c.get("user");
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json(err("bad_request"), 400);
    if (typeof body.display_name === "string" && body.display_name.trim()) {
      db.query("UPDATE hunt_users SET display_name = ? WHERE id = ?").run(
        body.display_name.trim().slice(0, 40),
        u.id,
      );
    }
    if (typeof body.publicity_opt_out === "boolean") {
      db.query("UPDATE hunt_users SET publicity_opt_out = ? WHERE id = ?").run(
        body.publicity_opt_out ? 1 : 0,
        u.id,
      );
    }
    const fresh = db.query("SELECT * FROM hunt_users WHERE id = ?").get(u.id) as UserRow;
    return c.json({
      id: fresh.id,
      display_name: fresh.display_name,
      email: fresh.email,
      publicity_opt_out: fresh.publicity_opt_out === 1,
    });
  });

  app.post("/v1/claims", requireUser, async (c) => {
    const parsed = parseClaimBody(await c.req.json().catch(() => null));
    if (!parsed) return c.json(err("bad_request"), 400);
    const ev = getEventById(db, parsed.event_id);
    if (!ev) return c.json(err("event_not_found"), 404);
    const r = evaluateClaim(db, {
      user: c.get("user"),
      event: ev,
      bodyId: parsed.body_id,
      position: parsed.position,
      clientTs: parsed.client_ts,
      via: "claim",
      now: Date.now(),
      codeKey,
      limiter,
    });
    return claimResponse(c, r, ev.slug);
  });

  app.post("/v1/positions", requireUser, async (c) => {
    const parsed = parseClaimBody(await c.req.json().catch(() => null));
    if (!parsed) return c.json(err("bad_request"), 400);
    const ev = getEventById(db, parsed.event_id);
    if (!ev) return c.json(err("event_not_found"), 404);
    // Continuous claim evaluation rides the ping (hunt v0 delta 1).
    const r = evaluateClaim(db, {
      user: c.get("user"),
      event: ev,
      bodyId: parsed.body_id,
      position: parsed.position,
      clientTs: parsed.client_ts,
      via: "ping",
      now: Date.now(),
      codeKey,
      limiter,
    });
    if (r.result === "no_prize_in_radius") return c.body(null, 204);
    return claimResponse(c, r, ev.slug);
  });

  app.get("/v1/me/wins", requireUser, (c) => {
    return c.json({ wins: listWins(db, c.get("user"), codeKey, Date.now()) });
  });

  // Phase 2 shape reserved — not built (SPEC §9).
  app.put("/v1/me/payout-address", requireUser, (c) =>
    c.json(err("not_implemented_phase_2"), 501),
  );

  // ---------- announcement feeds (SSE, SPEC §8.3) ----------
  const feedHandler = (includePings: boolean, eventId: string | null) => (c: any) => {
    const afterParam = Number(c.req.query("after") ?? 0);
    let lastId = Number.isFinite(afterParam) ? afterParam : 0;
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      // Flush headers + warm the connection immediately: with no
      // announcements yet, a silent stream trips Bun.serve's idle timeout
      // before the first real event (found in slice-6 testing).
      await stream.writeSSE({ event: "heartbeat", data: "{}" });
      let beats = 0;
      while (!aborted) {
        const rows = db
          .query(
            `SELECT id, event_id, type, payload_json FROM announcements
             WHERE id > ? ${eventId ? "AND event_id = ?" : ""} ${includePings ? "" : "AND type != 'ping'"}
             ORDER BY id LIMIT 100`,
          )
          .all(...(eventId ? [lastId, eventId] : [lastId])) as {
          id: number;
          event_id: string | null;
          type: string;
          payload_json: string;
        }[];
        for (const row of rows) {
          lastId = row.id;
          await stream.writeSSE({
            id: String(row.id),
            event: row.type,
            data: row.payload_json,
          });
        }
        beats++;
        if (beats % 30 === 0) await stream.writeSSE({ event: "heartbeat", data: "{}" });
        await stream.sleep(500);
      }
    });
  };

  app.get("/v1/events/:slug/feed", (c) => {
    const ev = getEventBySlug(db, c.req.param("slug"));
    if (!ev) return c.json(err("event_not_found"), 404);
    return feedHandler(false, ev.id)(c);
  });

  app.get("/v1/feed", requireUser, (c) => feedHandler(true, null)(c));

  // ---------- admin ----------
  app.post("/v1/admin/events", requireAdmin, async (c) => {
    const b = await c.req.json().catch(() => null);
    if (
      !b ||
      typeof b.slug !== "string" ||
      typeof b.title !== "string" ||
      typeof b.district !== "string" ||
      !Number.isFinite(b.starts_at) ||
      !Number.isFinite(b.ends_at) ||
      !Number.isInteger(b.pool_cap_cents)
    ) {
      return c.json(err("bad_request"), 400);
    }
    const id = newId();
    db.query(
      `INSERT INTO events (id, slug, title, district, starts_at, ends_at, state, pool_cap_cents, claim_radius_m, tier, created_by, created_at)
       VALUES (?,?,?,?,?,?, 'draft', ?, ?, ?, 'admin', ?)`,
    ).run(
      id,
      b.slug,
      b.title,
      b.district,
      b.starts_at,
      b.ends_at,
      b.pool_cap_cents,
      Number.isFinite(b.claim_radius_m) ? b.claim_radius_m : DEFAULT_CLAIM_RADIUS_M,
      typeof b.tier === "string" ? b.tier : "major",
      Date.now(),
    );
    return c.json({ id, slug: b.slug }, 201);
  });

  const seedPrizes = async (c: any) => {
    const ev = getEventById(db, c.req.param("id"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const b = await c.req.json().catch(() => null);
    if (!b || !Array.isArray(b.prizes) || b.prizes.length === 0) {
      return c.json(err("bad_request"), 400);
    }
    const now = Date.now();
    const added = b.prizes.reduce(
      (s: number, p: any) => s + (Number.isInteger(p?.face_value_cents) ? p.face_value_cents : 0),
      0,
    );
    // I2: the seed transaction fails atomically if the pool cap would break.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (poolSeededTotal(db, ev.id) + added > ev.pool_cap_cents) {
        db.exec("ROLLBACK");
        return c.json(err("pool_cap_exceeded"), 422);
      }
      for (const p of b.prizes) {
        if (
          typeof p?.label_public !== "string" ||
          typeof p?.kind !== "string" ||
          !Number.isInteger(p?.face_value_cents) ||
          !Number.isFinite(p?.x) ||
          !Number.isFinite(p?.y) ||
          !Number.isFinite(p?.z) ||
          typeof p?.code !== "string"
        ) {
          db.exec("ROLLBACK");
          return c.json(err("bad_request"), 400);
        }
        const enc = encryptCode(codeKey, p.code);
        const pid = newId();
        db.query(
          `INSERT INTO prizes (id, event_id, label_public, kind, face_value_cents, x, y, z, code_encrypted, code_nonce, state, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'seeded', ?)`,
        ).run(
          pid,
          ev.id,
          p.label_public,
          p.kind,
          p.face_value_cents,
          p.x,
          p.y,
          p.z,
          enc.ciphertext,
          enc.nonce,
          now,
        );
        ledgerInsert(db, ev.id, "seed", pid, p.face_value_cents, now);
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
    return c.json({ seeded: b.prizes.length }, 201);
  };
  app.post("/v1/admin/events/:id/prizes:bulk", requireAdmin, seedPrizes);
  app.post("/v1/admin/events/:id/prizes/bulk", requireAdmin, seedPrizes);

  const seedHints = async (c: any) => {
    const ev = getEventById(db, c.req.param("id"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const b = await c.req.json().catch(() => null);
    if (!b || !Array.isArray(b.hints)) return c.json(err("bad_request"), 400);
    for (const h of b.hints) {
      if (typeof h?.tier !== "string" || typeof h?.text !== "string") {
        return c.json(err("bad_request"), 400);
      }
      db.query(
        `INSERT INTO hint_schedule (id, event_id, tier, text, fires_at, progress_kind, progress_value, area_x, area_z, area_radius_m)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newId(),
        ev.id,
        h.tier,
        h.text,
        Number.isFinite(h.fires_at) ? h.fires_at : null,
        typeof h.progress_kind === "string" ? h.progress_kind : null,
        Number.isFinite(h.progress_value) ? h.progress_value : null,
        Number.isFinite(h.area_x) ? h.area_x : null,
        Number.isFinite(h.area_z) ? h.area_z : null,
        Number.isFinite(h.area_radius_m) ? h.area_radius_m : null,
      );
    }
    return c.json({ seeded: b.hints.length }, 201);
  };
  app.post("/v1/admin/events/:id/hints:bulk", requireAdmin, seedHints);
  app.post("/v1/admin/events/:id/hints/bulk", requireAdmin, seedHints);

  const stateControl = (target: string) => async (c: any) => {
    const ev = getEventById(db, c.req.param("id"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const now = Date.now();
    if (target === "schedule") {
      db.query("UPDATE events SET state = 'scheduled' WHERE id = ?").run(ev.id);
    } else if (target === "pause") {
      db.query("UPDATE events SET state = 'paused' WHERE id = ?").run(ev.id);
    } else if (target === "cancel") {
      db.query("UPDATE events SET state = 'cancelled' WHERE id = ?").run(ev.id);
      auditInsert(db, "admin", "event_cancel", ev.id, null, now);
    } else if (target === "end") {
      db.query("UPDATE events SET ends_at = ? WHERE id = ?").run(now, ev.id);
    }
    tickOnce(db, now); // transitions + announcements settle synchronously
    const fresh = getEventById(db, ev.id)!;
    return c.json({ id: fresh.id, state: fresh.state });
  };
  app.post("/v1/admin/events/:id/schedule", requireAdmin, stateControl("schedule"));
  app.post("/v1/admin/events/:id/pause", requireAdmin, stateControl("pause"));
  app.post("/v1/admin/events/:id/cancel", requireAdmin, stateControl("cancel"));
  app.post("/v1/admin/events/:id/end", requireAdmin, stateControl("end"));

  app.get("/v1/admin/events/:id/claims", requireAdmin, (c) => {
    const ev = getEventById(db, c.req.param("id"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const verdict = c.req.query("verdict");
    const user = c.req.query("user");
    let sql = "SELECT * FROM claim_attempts WHERE event_id = ?";
    const params: unknown[] = [ev.id];
    if (verdict) {
      sql += " AND verdict = ?";
      params.push(verdict);
    }
    if (user) {
      sql += " AND user_id = ?";
      params.push(user);
    }
    sql += " ORDER BY received_at LIMIT 500";
    const attempts = db.query(sql).all(...(params as any[]));
    let trail: unknown[] = [];
    if (user) {
      trail = db
        .query(
          "SELECT x, y, z, body_id, received_at FROM position_samples WHERE event_id = ? AND user_id = ? ORDER BY received_at LIMIT 1000",
        )
        .all(ev.id, user);
    }
    return c.json({ attempts, trail });
  });

  app.get("/v1/admin/events/:id/ledger", requireAdmin, (c) => {
    const ev = getEventById(db, c.req.param("id"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const rows = db
      .query("SELECT * FROM pool_ledger WHERE event_id = ? ORDER BY created_at, rowid")
      .all(ev.id);
    return c.json({ ledger: rows });
  });

  app.get("/v1/admin/events/:id/receipts", requireAdmin, (c) => {
    const ev = getEventById(db, c.req.param("id"));
    if (!ev) return c.json(err("event_not_found"), 404);
    const rows = db
      .query(
        `SELECT u.display_name AS winner_display_name, p.label_public AS prize_label,
                p.face_value_cents, p.claimed_at,
                po.recipient AS payout_recipient, po.status AS payout_state,
                po.transaction_id AS payout_transaction_id
         FROM prizes p JOIN hunt_users u ON u.id = p.claimed_by_user_id
         LEFT JOIN payouts po ON po.prize_id = p.id
         WHERE p.event_id = ? AND p.state = 'claimed' ORDER BY p.claimed_at`,
      )
      .all(ev.id) as Record<string, unknown>[];
    return c.json({
      receipts: rows.map((r) => {
        const { payout_recipient, payout_state, payout_transaction_id, ...base } = r;
        if (typeof payout_state !== "string") {
          // No payout row — Phase 1 shape, unchanged (SPEC §9).
          return { ...base, payout_address: null, payout_status: "n/a_code_revealed" };
        }
        // Phase 2 (§9): the published receipt — masked address, real status.
        return {
          ...base,
          payout_address: maskAddress(String(payout_recipient)),
          payout_status: payout_state,
          payout_transaction_id: payout_transaction_id ?? null,
        };
      }),
    });
  });

  // ---------- payouts (Phase 2; routes exist only when the rail is enabled) ----------
  if (paypal) {
    app.post("/v1/admin/prizes/:id/payout", requireAdmin, async (c) => {
      try {
        const row = await initiatePayout(db, paypal, cfg.paypal.mode, c.req.param("id"), Date.now());
        return c.json({ payout: payoutView(row) }, row.batch_id ? 200 : 202);
      } catch (e) {
        if (e instanceof PayoutError) {
          const status = e.code === "prize_not_found" ? 404 : 422;
          return c.json(err(e.code), status);
        }
        throw e;
      }
    });

    app.get("/v1/admin/payouts/:id", requireAdmin, async (c) => {
      const existing = getPayoutById(db, c.req.param("id"));
      if (!existing) return c.json(err("payout_not_found"), 404);
      const row = await refreshPayout(db, paypal, existing.id, Date.now());
      return c.json({ payout: payoutView(row) });
    });

    // Cancel an unclaimed payout. A PayPal-side failure is a 502 with
    // the row untouched — this route never reports a cancel PayPal
    // did not confirm.
    app.post("/v1/admin/payouts/:id/cancel", requireAdmin, async (c) => {
      const existing = getPayoutById(db, c.req.param("id"));
      if (!existing) return c.json(err("payout_not_found"), 404);
      try {
        const row = await cancelPayout(db, paypal, existing.id, Date.now());
        return c.json({ payout: payoutView(row) });
      } catch (e) {
        if (e instanceof PayoutError) return c.json(err(e.code), 422);
        if (e instanceof PaypalError) return c.json(err("paypal_cancel_failed"), 502);
        throw e;
      }
    });

    // PayPal webhook intake. The raw body is parsed here but nothing in
    // it is trusted until the verify call inside handlePayoutWebhook.
    app.post("/v1/paypal/webhooks", async (c) => {
      const event = await c.req.json().catch(() => null);
      if (!event) return c.json(err("bad_request"), 400);
      const outcome = await handlePayoutWebhook(
        db,
        paypal,
        cfg.paypal,
        {
          authAlgo: c.req.header("paypal-auth-algo") ?? null,
          certUrl: c.req.header("paypal-cert-url") ?? null,
          transmissionId: c.req.header("paypal-transmission-id") ?? null,
          transmissionSig: c.req.header("paypal-transmission-sig") ?? null,
          transmissionTime: c.req.header("paypal-transmission-time") ?? null,
        },
        event,
        Date.now(),
      );
      if (!outcome.accepted) return c.json(err(outcome.reason ?? "rejected"), 400);
      return c.json({ ok: true, ...(outcome.reason ? { note: outcome.reason } : {}) });
    });
  }

  app.post("/v1/admin/prizes/:id/void", requireAdmin, async (c) => {
    const row = db.query("SELECT * FROM prizes WHERE id = ?").get(c.req.param("id")) as {
      id: string;
      event_id: string;
      state: string;
      face_value_cents: number;
    } | null;
    if (!row) return c.json(err("prize_not_found"), 404);
    if (row.state === "claimed") return c.json(err("cannot_void_claimed"), 409);
    const now = Date.now();
    db.query("UPDATE prizes SET state = 'voided' WHERE id = ?").run(row.id);
    ledgerInsert(db, row.event_id, "void", row.id, row.face_value_cents, now);
    auditInsert(db, "admin", "prize_void", row.id, null, now);
    return c.json({ id: row.id, state: "voided" });
  });

  app.post("/v1/admin/prizes/:id/reveal", requireAdmin, (c) => {
    const row = db
      .query("SELECT code_encrypted, code_nonce FROM prizes WHERE id = ?")
      .get(c.req.param("id")) as { code_encrypted: Buffer; code_nonce: Buffer } | null;
    if (!row) return c.json(err("prize_not_found"), 404);
    // Custody path (b) — admin reveal, always audit-logged (SPEC §5.4).
    auditInsert(db, "admin", "prize_reveal", c.req.param("id"), null, Date.now());
    return c.json({
      code: decryptCode(codeKey, { ciphertext: row.code_encrypted, nonce: row.code_nonce }),
    });
  });

  app.post("/v1/admin/users/:id/suspend", requireAdmin, (c) => {
    const now = Date.now();
    db.query("UPDATE hunt_users SET status = 'suspended' WHERE id = ?").run(c.req.param("id"));
    auditInsert(db, "admin", "user_suspend", c.req.param("id"), null, now);
    return c.json({ id: c.req.param("id"), status: "suspended" });
  });

  return app;
}
