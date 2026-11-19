import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { EGGS, EGG_CLAIM_RANGE_M } from "@aiverse/shared/eggs";
import { eggHuntWins } from "@aiverse/shared/schema";
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
    outcome: z.object({ ok: z.literal(true), status: z.literal("done"), target: z.string() }),
    interactionPose: position,
  }),
});
const observation = z.object({ observation: z.object({ t: z.number(), body: position }) });
const claim = z.object({ contestId: z.string(), actId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }).strict();

/** The gateway holds the prize assignment. Agents only receive the clue until there is a winner. */
export function eggHuntFromEnv(sim: SimClient) {
  if (!process.env.AIVERSE_EGG_HUNT) return null;
  let input: unknown;
  try { input = JSON.parse(process.env.AIVERSE_EGG_HUNT); } catch { return null; }
  const config = contest.safeParse(input);
  if (!config.success) return null;
  const { id, clue, eggId, payload, credits } = config.data;
  const [x, y, zPos] = EGGS[eggId]!.position;
  const route = new Hono<{ Variables: { agentId: string } }>();
  const getWin = () => db.query.eggHuntWins.findFirst({ where: eq(eggHuntWins.contestId, id) });
  const receipt = (win: typeof eggHuntWins.$inferSelect) => ({ payload: win.payload, credits: win.credits });

  route.get("/", async (c) => {
    const win = await getWin();
    return c.json({ id, clue, credits: win?.credits ?? credits, status: win ? "closed" : "open",
      ...(win && win.agentId === c.get("agentId") ? { reward: receipt(win) } : {}) });
  });

  route.post("/claim", async (c) => {
    const submitted = claim.safeParse(await c.req.json().catch(() => null));
    if (!submitted.success) return c.json({ error: "contestId_and_actId_required" }, 400);
    if (submitted.data.contestId !== id) return c.json({ error: "unknown_contest" }, 404);
    const agentId = c.get("agentId");
    const existing = await getWin();
    if (existing) return existing.agentId === agentId
      ? c.json({ status: "won", reward: receipt(existing) })
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
    const { interactionPose: pose, outcome, settledAt } = proof.data.act;
    const { body, t } = view.data.observation;
    if (t - settledAt > 30) return c.json({ error: "open_an_egg_first" }, 403);
    if (outcome.target !== eggId || Math.hypot(pose.x - x, pose.z - zPos) > 1.2 ||
      Math.abs(pose.y - y) > 0.75) return c.json({ error: "no_prize_in_this_egg" }, 403);
    if (Math.hypot(body.x - x, body.z - zPos) > EGG_CLAIM_RANGE_M ||
      Math.abs(body.y - y) > 0.75) return c.json({ error: "return_to_the_egg" }, 403);

    // This row is the test-credit award. Its primary key permits exactly one winner per contest.
    const [won] = await db.insert(eggHuntWins).values({ contestId: id, agentId, payload, credits })
      .onConflictDoNothing().returning();
    if (won) return c.json({ status: "won", reward: receipt(won) }, 201);
    const winner = await getWin();
    return winner?.agentId === agentId
      ? c.json({ status: "won", reward: receipt(winner) })
      : c.json({ error: "already_won" }, 409);
  });

  return route;
}
