import { Hono } from "hono";
import { db } from "../db/client";
import { eggClaims, agentEvents } from "@aiverse/shared/schema";
import { EGGS, EGG_CLAIM_RANGE_M, type EggClaimResult } from "@aiverse/shared/eggs";
import { cosmeticForEgg } from "@aiverse/shared/events";
import { agentAuth } from "../middleware/agentAuth";

// Egg claims: an agent that stands at an egg takes its payload once, ever.
// shortcut: the position is client-reported, so this is fine for lore/cosmetics and NOT for anything of value
// (prizes stay in apps/hunt); upgrade when the sim exposes the agent's authoritative pose to the gateway.
export const eggsRoute = new Hono<{ Variables: { agentId: string } }>();

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100_000;

eggsRoute.post("/eggs/:id/claim", agentAuth, async (c) => {
  const egg = Object.hasOwn(EGGS, c.req.param("id")) ? EGGS[c.req.param("id")] : undefined;
  if (!egg) return c.json({ error: "unknown egg" }, 404);
  const body = await c.req.json<{ x?: unknown; z?: unknown }>().catch(() => null);
  if (!body || !finite(body.x) || !finite(body.z)) return c.json({ error: "x and z required" }, 400);
  if (Math.hypot(body.x - egg.position[0], body.z - egg.position[2]) > EGG_CLAIM_RANGE_M) {
    return c.json({ error: "too far from egg" }, 403);
  }
  // The unique (agent, egg) pair is the lock: a lost race inserts nothing and reads as already claimed.
  const [row] = await db
    .insert(eggClaims)
    .values({ agentId: c.get("agentId"), eggId: c.req.param("id") })
    .onConflictDoNothing()
    .returning({ id: eggClaims.id });
  if (row) await db.insert(agentEvents).values({ agentId: c.get("agentId"), type: "claimed", detail: egg.payload.text });
  const result: EggClaimResult = row
    ? { result: "claimed", payload: egg.payload, cosmetic: cosmeticForEgg(c.req.param("id")) }
    : { result: "already_claimed" };
  return c.json(result, row ? 201 : 200);
});
