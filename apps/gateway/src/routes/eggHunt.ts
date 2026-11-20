import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { EGGS, EGG_CLAIM_RANGE_M } from "@aiverse/shared/eggs";
import { eggCashBounties, eggHuntWins } from "@aiverse/shared/schema";
import { db } from "../db/client";
import type { SimClient } from "../world/simClient";

const contest = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  clue: z.string().min(1).max(500),
  eggId: z.string().refine((id) => Object.hasOwn(EGGS, id)),
  payload: z.string().min(1).max(1000),
  credits: z.number().int().min(1).max(50),
});

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });
const actionProof = z.object({
  act: z.object({
    action: z.object({ type: z.literal("interact") }),
    state: z.literal("settled"),
    settledAt: z.number(),
    interactionStartedAtMs: z.number().optional(),
    outcome: z.object({ ok: z.literal(true), status: z.literal("done"), target: z.string() }),
    interactionPose: position,
  }),
});
const observation = z.object({ observation: z.object({ t: z.number(), body: position }) });
const claim = z.object({ contestId: z.string(), actId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }).strict();

function legacyContest() {
  try { return contest.safeParse(JSON.parse(process.env.AIVERSE_EGG_HUNT ?? "null")).data; }
  catch { return undefined; }
}

/** The gateway holds the egg assignment. Agents receive the clue and advertised prize. */
export function createEggHuntRoute(sim: SimClient) {
  const legacy = legacyContest();
  const getContest = async () => {
    const cash = await db.query.eggCashBounties.findFirst({ where: eq(eggCashBounties.current, true) });
    return cash
      ? { ...cash, credits: 0, cashBounty: { amountCents: cash.amountCents, currency: "USD", mode: cash.mode } }
      : legacy && { ...legacy, createdAt: null, cashBounty: null };
  };
  const route = new Hono<{ Variables: { agentId: string; ownerId: string } }>();
  const getWin = (id: string) => db.query.eggHuntWins.findFirst({ where: eq(eggHuntWins.contestId, id) });
  const receipt = (win: typeof eggHuntWins.$inferSelect) => ({ payload: win.payload, credits: win.credits });

  route.get("/", async (c) => {
    const current = await getContest();
    if (!current) return c.json({ error: "no_active_hunt" }, 404);
    const { id, clue, credits, cashBounty } = current;
    const win = await getWin(id);
    return c.json({ id, clue, credits: win?.credits ?? credits, status: win ? "closed" : "open",
      ...(cashBounty ? { cashBounty } : {}),
      ...(win && win.agentId === c.get("agentId") ? { reward: receipt(win) } : {}) });
  });

  route.post("/claim", async (c) => {
    const submitted = claim.safeParse(await c.req.json().catch(() => null));
    if (!submitted.success) return c.json({ error: "contestId_and_actId_required" }, 400);
    const current = await getContest();
    if (!current || submitted.data.contestId !== current.id) return c.json({ error: "unknown_contest" }, 404);
    const { id, eggId, payload, credits, createdAt, cashBounty } = current;
    const egg = EGGS[eggId];
    if (!egg) return c.json({ error: "egg_unavailable" }, 503);
    const [x, y, zPos] = egg.position;
    const agentId = c.get("agentId");
    const existing = await getWin(id);
    const success = (win: typeof eggHuntWins.$inferSelect) => ({
      status: "won", reward: receipt(win), ...(cashBounty ? { cashBounty } : {}),
    });
    if (existing) return existing.agentId === agentId
      ? c.json(success(existing))
      : c.json({ error: "already_won" }, 409);

    const [actResponse, viewResponse] = await Promise.all([
      sim.call("GET", `/bodies/${agentId}/act/${submitted.data.actId}`),
      sim.call("GET", `/bodies/${agentId}/observe`),
    ]).catch(() => []);
    if (actResponse?.status === 404 || viewResponse?.status === 404) return c.json({ error: "open_an_egg_first" }, 403);
    if (!actResponse?.ok || !viewResponse?.ok) return c.json({ error: "world_unavailable" }, 503);
    const proof = actionProof.safeParse(await actResponse.json().catch(() => null));
    if (!proof.success) return c.json({ error: "open_an_egg_first" }, 403);
    const view = observation.safeParse(await viewResponse.json().catch(() => null));
    if (!view.success) return c.json({ error: "world_unavailable" }, 503);
    const { interactionPose: pose, outcome, settledAt, interactionStartedAtMs } = proof.data.act;
    const { body, t } = view.data.observation;
    if (t - settledAt > 30) return c.json({ error: "open_an_egg_first" }, 403);
    if (createdAt && (interactionStartedAtMs ?? 0) < createdAt.getTime()) {
      return c.json({ error: "open_an_egg_after_bounty_starts" }, 403);
    }
    if (outcome.target !== eggId || Math.hypot(pose.x - x, pose.z - zPos) > 1.2 ||
      Math.abs(pose.y - y) > 0.75) return c.json({ error: "no_prize_in_this_egg" }, 403);
    if (Math.hypot(body.x - x, body.z - zPos) > EGG_CLAIM_RANGE_M ||
      Math.abs(body.y - y) > 0.75) return c.json({ error: "return_to_the_egg" }, 403);

    // The immutable win records the owner at claim time and permits one winner per contest.
    const [won] = await db.insert(eggHuntWins)
      .values({ contestId: id, agentId, ownerId: c.get("ownerId"), payload, credits, wonAt: new Date() })
      .onConflictDoNothing().returning();
    if (won) return c.json(success(won), 201);
    const winner = await getWin(id);
    return winner?.agentId === agentId
      ? c.json(success(winner))
      : c.json({ error: "already_won" }, 409);
  });

  return route;
}
