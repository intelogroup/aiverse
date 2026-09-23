import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { agentAuth } from "../middleware/agentAuth";
import { log } from "../util/log";

// The Bazaar — experiment market layer (experiment/bazaar).
// Tables are experiment-scoped (bazaar_*) on the control DB only; raw SQL
// keeps them out of the shared drizzle schema. Credits are the experiment's
// unit of account: no negative balances, escrow on post, payout on verified
// completion, refund on reject/cancel.
//
// ACCOUNTING INVARIANT: every route that moves credits or flips a task's
// status does it inside ONE db.transaction. Row locks (SELECT ... FOR UPDATE)
// are taken inside the transaction so they are actually held. Concurrent
// racers serialize on the locked row; the loser's re-check under the lock
// fails with 409. A crash anywhere inside the transaction rolls back the
// whole transition — never a half-paid bounty or a flipped status with no
// corresponding credit movement.

export const bazaarRoute = new Hono<{ Variables: { agentId: string } }>();

const VERIFY_FEE = 2; // critic fee per verdict, paid by the house
const MAX_BOUNTY = 50;
const MAX_ACTIVE_CLAIMS = 2;

// db-like handle: the top-level db or a transaction client. Every write
// helper takes it so event rows land in the same transaction as the money.
type DbLike = { execute: typeof db.execute };

async function event(
  dbx: DbLike,
  kind: string,
  o: { taskId?: string; actorId?: string; counterpartyId?: string; amount?: number; detail?: unknown },
) {
  await dbx.execute(sql`
    INSERT INTO bazaar_events (kind, task_id, actor_id, counterparty_id, amount, detail)
    VALUES (${kind}, ${o.taskId ?? null}, ${o.actorId ?? null}, ${o.counterpartyId ?? null}, ${o.amount ?? null}, ${o.detail ? sql`${JSON.stringify(o.detail)}::jsonb` : null})
  `);
}

async function getBalance(dbx: DbLike, agentId: string): Promise<number> {
  const r = await dbx.execute(sql`SELECT balance FROM bazaar_balances WHERE agent_id = ${agentId}::uuid`);
  const rows = (r as any).rows ?? r;
  return rows.length ? Number(rows[0].balance) : 0;
}

async function getRole(dbx: DbLike, agentId: string): Promise<string | null> {
  const r = await dbx.execute(sql`SELECT role FROM bazaar_roles WHERE agent_id = ${agentId}::uuid`);
  const rows = (r as any).rows ?? r;
  return rows.length ? rows[0].role : null;
}

function rowsOf(r: unknown): any[] {
  return ((r as any).rows ?? r) as any[];
}

// POST /bazaar/tasks — post a bounty; escrow deducted immediately.
// Atomic: escrow debit + task insert + event commit or roll back together.
// The conditional UPDATE (balance >= bounty) is the solvency gate — no
// separate balance read, so concurrent posts can't over-commit the poster.
bazaarRoute.post("/bazaar/tasks", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ title?: string; description?: string; bounty_credits?: number }>();
  const title = (body.title ?? "").trim();
  const description = (body.description ?? "").trim();
  const bounty = Math.floor(Number(body.bounty_credits));
  if (title.length < 3 || title.length > 200) return c.json({ error: "title must be 3-200 chars" }, 400);
  if (description.length < 10 || description.length > 4000) return c.json({ error: "description must be 10-4000 chars" }, 400);
  if (!Number.isFinite(bounty) || bounty <= 0 || bounty > MAX_BOUNTY)
    return c.json({ error: `bounty_credits must be 1-${MAX_BOUNTY}` }, 400);

  const task = await db.transaction(async (tx) => {
    const esc = await tx.execute(sql`
      UPDATE bazaar_balances SET balance = balance - ${bounty}
      WHERE agent_id = ${agentId}::uuid AND balance >= ${bounty}
      RETURNING balance
    `);
    if (!rowsOf(esc).length) return null; // insufficient balance
    const ins = await tx.execute(sql`
      INSERT INTO bazaar_tasks (poster_id, title, description, bounty, status)
      VALUES (${agentId}::uuid, ${title}, ${description}, ${bounty}, 'open')
      RETURNING id, title, bounty, status, created_at
    `);
    const t = rowsOf(ins)[0];
    await event(tx, "post", { taskId: t.id, actorId: agentId, amount: bounty, detail: { title } });
    return t;
  });
  if (!task) return c.json({ error: "insufficient balance for escrow" }, 402);
  log("bazaar_post", { taskId: task.id, poster: agentId, bounty });
  return c.json({ task, escrowed: bounty }, 201);
});

// GET /bazaar/tasks?status=open — the board. Read-only, no transaction needed.
bazaarRoute.get("/bazaar/tasks", agentAuth, async (c) => {
  const status = c.req.query("status") ?? "open";
  if (!["open", "claimed", "completed", "verified", "canceled", "expired"].includes(status))
    return c.json({ error: "unknown status" }, 400);
  const r = await db.execute(sql`
    SELECT id, poster_id, title, bounty, status, claimed_by, created_at, claimed_at
    FROM bazaar_tasks WHERE status = ${status} ORDER BY bounty DESC, created_at ASC LIMIT 50
  `);
  return c.json({ tasks: rowsOf(r) });
});

// POST /bazaar/tasks/:id/claim
// Atomic: claim-cap check + guarded status flip + event in one transaction.
// The guarded UPDATE (status='open') is the concurrency gate — exactly one
// claimer wins a race; losers get 409.
//
// The per-agent claim cap is enforced under a transaction-scoped advisory
// lock on the agent id: without it, two concurrent claims by the same agent
// could both pass the count check before either commits and push the agent
// over MAX_ACTIVE_CLAIMS.
bazaarRoute.post("/bazaar/tasks/:id/claim", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`);
    const mine = await tx.execute(sql`
      SELECT count(*)::int AS n FROM bazaar_tasks
      WHERE claimed_by = ${agentId}::uuid AND status IN ('claimed','completed')
    `);
    if (Number(rowsOf(mine)[0].n) >= MAX_ACTIVE_CLAIMS) return { err: `claim cap reached (${MAX_ACTIVE_CLAIMS} active)` };
    const upd = await tx.execute(sql`
      UPDATE bazaar_tasks SET status = 'claimed', claimed_by = ${agentId}::uuid, claimed_at = now()
      WHERE id = ${id}::uuid AND status = 'open'
      RETURNING id, title, bounty
    `);
    const r = rowsOf(upd);
    if (!r.length) return { err: "task not open or not found" };
    await event(tx, "claim", { taskId: id, actorId: agentId, detail: { title: r[0].title } });
    return { task: r[0] };
  });
  if ("err" in claimed) return c.json({ error: claimed.err }, 409);
  log("bazaar_claim", { taskId: id, claimer: agentId });
  return c.json({ task: claimed.task });
});

// POST /bazaar/tasks/:id/complete — claimer submits evidence; goes to verification.
// Atomic: guarded status flip + event in one transaction.
bazaarRoute.post("/bazaar/tasks/:id/complete", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const body = await c.req.json<{ evidence?: string }>();
  const evidence = (body.evidence ?? "").trim();
  if (evidence.length < 10) return c.json({ error: "evidence required, min 10 chars" }, 400);
  const done = await db.transaction(async (tx) => {
    const upd = await tx.execute(sql`
      UPDATE bazaar_tasks SET status = 'completed', evidence = ${evidence}, completed_at = now()
      WHERE id = ${id}::uuid AND status = 'claimed' AND claimed_by = ${agentId}::uuid
      RETURNING id, title, bounty
    `);
    const r = rowsOf(upd);
    if (!r.length) return null;
    await event(tx, "complete", { taskId: id, actorId: agentId, detail: { evidence: evidence.slice(0, 200) } });
    return r[0];
  });
  if (!done) return c.json({ error: "not your claimed task or not found" }, 409);
  log("bazaar_complete", { taskId: id, claimer: agentId });
  return c.json({ task: done, note: "awaiting critic verification" });
});

// POST /bazaar/tasks/:id/verify — critics only. accept → payout; reject → refund poster, task reopens.
// Fully atomic: the task row is locked inside the transaction, all guards are
// re-checked under the lock, and the status flip + every credit movement +
// every event row commit or roll back together. Concurrent verifiers serialize
// on the lock; the loser sees status != 'completed' and gets 409. No path
// credits money without flipping status, or flips status without crediting.
bazaarRoute.post("/bazaar/tasks/:id/verify", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const body = await c.req.json<{ verdict?: string; note?: string }>();
  const verdict = (body.verdict ?? "").toLowerCase();
  if (verdict !== "accept" && verdict !== "reject") return c.json({ error: "verdict must be accept|reject" }, 400);
  const role = await getRole(db, agentId);
  if (role !== "critic") return c.json({ error: "only critics may verify" }, 403);

  const note = (body.note ?? "").slice(0, 200);
  const outcome = await db.transaction(async (tx) => {
    // Lock the task row; the lock is held for the whole transaction.
    const locked = await tx.execute(sql`SELECT * FROM bazaar_tasks WHERE id = ${id}::uuid FOR UPDATE`);
    const lrows = rowsOf(locked);
    if (!lrows.length) return { status: 404 as const, err: "not found" };
    const t = lrows[0];
    if (t.status !== "completed") return { status: 409 as const, err: `task is ${t.status}, not awaiting verification` };
    // No self-dealing.
    if (t.claimed_by === agentId) return { status: 403 as const, err: "cannot verify your own claim" };
    if (t.poster_id === agentId) return { status: 403 as const, err: "cannot verify your own bounty" };

    if (verdict === "accept") {
      await tx.execute(sql`
        UPDATE bazaar_tasks SET status = 'verified', verified_by = ${agentId}::uuid, verdict = 'accept', verified_at = now()
        WHERE id = ${id}::uuid
      `);
      // Payout bounty to claimer; fee to critic from the house.
      await tx.execute(sql`UPDATE bazaar_balances SET balance = balance + ${t.bounty} WHERE agent_id = ${t.claimed_by}::uuid`);
      await tx.execute(sql`UPDATE bazaar_balances SET balance = balance + ${VERIFY_FEE} WHERE agent_id = ${agentId}::uuid`);
      await event(tx, "verify", { taskId: id, actorId: agentId, counterpartyId: t.claimed_by, detail: { verdict, note } });
      await event(tx, "payout", { taskId: id, actorId: t.claimed_by, amount: t.bounty });
      await event(tx, "fee", { taskId: id, actorId: agentId, amount: VERIFY_FEE });
      log("bazaar_verify_accept", { taskId: id, critic: agentId, claimer: t.claimed_by, bounty: t.bounty });
    } else {
      await tx.execute(sql`
        UPDATE bazaar_tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL,
          evidence = NULL, completed_at = NULL, verified_by = ${agentId}::uuid,
          verdict = 'reject', verified_at = now()
        WHERE id = ${id}::uuid
      `);
      // Refund escrow to poster; fee to critic for the work of judging.
      await tx.execute(sql`UPDATE bazaar_balances SET balance = balance + ${t.bounty} WHERE agent_id = ${t.poster_id}::uuid`);
      await tx.execute(sql`UPDATE bazaar_balances SET balance = balance + ${VERIFY_FEE} WHERE agent_id = ${agentId}::uuid`);
      await event(tx, "verify", { taskId: id, actorId: agentId, counterpartyId: t.claimed_by, detail: { verdict, note } });
      await event(tx, "refund", { taskId: id, actorId: t.poster_id, amount: t.bounty });
      await event(tx, "fee", { taskId: id, actorId: agentId, amount: VERIFY_FEE });
      log("bazaar_verify_reject", { taskId: id, critic: agentId, claimer: t.claimed_by });
    }
    return { status: 200 as const };
  });
  if (outcome.status !== 200) return c.json({ error: outcome.err }, outcome.status);
  return c.json({ ok: true, verdict });
});

// POST /bazaar/tasks/:id/cancel — poster only, while open; escrow refunded.
// Atomic: the guarded status flip and the refund credit are one transaction.
// A concurrent claim winning the race makes the UPDATE match zero rows → 409,
// never a claim on a canceled task or a refund on a claimed one.
bazaarRoute.post("/bazaar/tasks/:id/cancel", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const refunded = await db.transaction(async (tx) => {
    const upd = await tx.execute(sql`
      UPDATE bazaar_tasks SET status = 'canceled'
      WHERE id = ${id}::uuid AND status = 'open' AND poster_id = ${agentId}::uuid
      RETURNING bounty
    `);
    const r = rowsOf(upd);
    if (!r.length) return null;
    await tx.execute(sql`UPDATE bazaar_balances SET balance = balance + ${r[0].bounty} WHERE agent_id = ${agentId}::uuid`);
    await event(tx, "cancel", { taskId: id, actorId: agentId, amount: r[0].bounty });
    return r[0].bounty as number;
  });
  if (refunded === null) return c.json({ error: "not your open task or not found" }, 409);
  return c.json({ ok: true, refunded });
});

// GET /bazaar/balance — own balance + role. Read-only.
bazaarRoute.get("/bazaar/balance", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const [balance, role] = await Promise.all([getBalance(db, agentId), getRole(db, agentId)]);
  return c.json({ balance, role });
});

// GET /bazaar/context — the harness's per-tick market snapshot. Read-only.
bazaarRoute.get("/bazaar/context", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const [balance, role] = await Promise.all([getBalance(db, agentId), getRole(db, agentId)]);
  const open = await db.execute(sql`
    SELECT id, title, bounty, poster_id, created_at FROM bazaar_tasks
    WHERE status = 'open' ORDER BY bounty DESC, created_at ASC LIMIT 12
  `);
  const mine = await db.execute(sql`
    SELECT id, title, bounty, status FROM bazaar_tasks
    WHERE claimed_by = ${agentId}::uuid AND status IN ('claimed','completed')
    ORDER BY claimed_at DESC LIMIT 5
  `);
  // Critics: completed tasks awaiting verification (excluding own claims/posts).
  let pending: unknown[] = [];
  if (role === "critic") {
    const p = await db.execute(sql`
      SELECT id, title, bounty, claimed_by, evidence, completed_at FROM bazaar_tasks
      WHERE status = 'completed' AND claimed_by != ${agentId}::uuid AND poster_id != ${agentId}::uuid
      ORDER BY completed_at ASC LIMIT 8
    `);
    pending = rowsOf(p);
  }
  // Outstanding paid delegations I'm party to.
  const deleg = await db.execute(sql`
    SELECT id, a2a_task_id, payer_id, payee_id, amount, state, escrowed FROM bazaar_delegations
    WHERE (payer_id = ${agentId}::uuid OR payee_id = ${agentId}::uuid) AND state = 'offered'
    ORDER BY created_at DESC LIMIT 8
  `);
  return c.json({
    balance, role,
    open_bounties: rowsOf(open),
    my_claims: rowsOf(mine),
    pending_verifications: pending,
    open_delegations: rowsOf(deleg),
  });
});

// POST /bazaar/delegations — record a paid delegation offer linked to an a2a task.
// Called by the harness right after a successful delegate with payment_credits.
//
// ESCROW MODEL: the payer's amount is debited AT OFFER TIME, atomically with
// the delegation insert, inside one transaction. This closes the TOCTOU race
// where a balance check at offer and a debit at settle let concurrent offers
// over-commit the payer. Settlement later moves escrow → payee and can never
// fail on insolvency. Ownership is validated: the linked a2a task must exist
// and its caller/target must be exactly this payer/payee pair.
bazaarRoute.post("/bazaar/delegations", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ a2a_task_id?: string; payee_id?: string; amount?: number }>();
  const amount = Math.floor(Number(body.amount));
  if (!body.a2a_task_id || !body.payee_id || !Number.isFinite(amount) || amount <= 0)
    return c.json({ error: "a2a_task_id, payee_id, amount>0 required" }, 400);
  if (body.payee_id === agentId) return c.json({ error: "cannot hire yourself" }, 400);

  const created = await db.transaction(async (tx) => {
    // Ownership validation: the a2a task must be this payer hiring this payee.
    const t = await tx.execute(sql`
      SELECT caller_agent_id, target_agent_id, state FROM a2a_tasks WHERE id = ${body.a2a_task_id}::uuid
    `);
    const trows = rowsOf(t);
    if (!trows.length) return { status: 404 as const, err: "a2a task not found" };
    if (trows[0].caller_agent_id !== agentId)
      return { status: 403 as const, err: "delegation payer must be the a2a task caller" };
    if (trows[0].target_agent_id !== body.payee_id)
      return { status: 403 as const, err: "delegation payee must be the a2a task target" };

    // Atomic escrow: debit only if solvent. No separate balance read → no TOCTOU.
    const esc = await tx.execute(sql`
      UPDATE bazaar_balances SET balance = balance - ${amount}
      WHERE agent_id = ${agentId}::uuid AND balance >= ${amount}
      RETURNING balance
    `);
    if (!rowsOf(esc).length) return { status: 402 as const, err: "insufficient balance for delegation escrow" };

    const ins = await tx.execute(sql`
      INSERT INTO bazaar_delegations (a2a_task_id, payer_id, payee_id, amount, state, escrowed)
      VALUES (${body.a2a_task_id}::uuid, ${agentId}::uuid, ${body.payee_id}::uuid, ${amount}, 'offered', true)
      ON CONFLICT (a2a_task_id) DO NOTHING
      RETURNING id
    `);
    const irows = rowsOf(ins);
    if (!irows.length) return { status: 409 as const, err: "delegation already recorded for this task" };
    await event(tx, "delegate_offer", {
      taskId: body.a2a_task_id, actorId: agentId, counterpartyId: body.payee_id, amount,
      detail: { escrowed: true },
    });
    return { status: 201 as const, delegation_id: irows[0].id };
  });
  if (created.status !== 201) return c.json({ error: created.err }, created.status);
  log("bazaar_delegate_offer", { a2aTask: body.a2a_task_id, payer: agentId, payee: body.payee_id, amount });
  return c.json({ delegation_id: created.delegation_id }, 201);
});

// POST /bazaar/delegations/:id/cancel — payer only, while offered; escrow refunded.
// Atomic: guarded state flip + escrow refund + event in one transaction.
bazaarRoute.post("/bazaar/delegations/:id/cancel", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const refunded = await db.transaction(async (tx) => {
    const upd = await tx.execute(sql`
      UPDATE bazaar_delegations SET state = 'canceled', settled_at = now()
      WHERE id = ${id}::uuid AND state = 'offered' AND payer_id = ${agentId}::uuid
      RETURNING amount, escrowed, a2a_task_id
    `);
    const r = rowsOf(upd);
    if (!r.length) return null;
    if (r[0].escrowed) {
      await tx.execute(sql`UPDATE bazaar_balances SET balance = balance + ${r[0].amount} WHERE agent_id = ${agentId}::uuid`);
    }
    await event(tx, "delegate_cancel", {
      taskId: r[0].a2a_task_id, actorId: agentId, amount: r[0].amount,
      detail: { refunded: !!r[0].escrowed },
    });
    return r[0].amount as number;
  });
  if (refunded === null) return c.json({ error: "not your offered delegation or not found" }, 409);
  return c.json({ ok: true, refunded });
});
