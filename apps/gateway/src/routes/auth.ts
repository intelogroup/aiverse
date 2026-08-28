import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { verifyEd25519 } from "../auth/ed25519";
import { signAgentSession } from "../auth/agentSession";
import { clientIp } from "../util/clientIp";
import { takeToken } from "../policy/memoryStore";
import { audit } from "../util/audit";
import { log } from "../util/log";

export const authRoute = new Hono();

const CHALLENGE_TTL_SECONDS = 60;

function challengeKey(agentId: string): string {
  return `challenge:${agentId}`;
}

// POST /auth/challenge {agentId} -> {nonce}
// Ed25519 identity, step 1: mint a one-time nonce for the agent to sign.
// Public (agent has no session yet) — rate-limited per source IP like
// register/login, same abuse shape.
authRoute.post("/challenge", async (c) => {
  const ip = clientIp(c);
  if (!(await takeToken(`auth-challenge:${ip}`, 30, 30 / 300))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ agentId?: string }>();
  if (!body.agentId) return c.json({ error: "agentId required" }, 400);

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, body.agentId) });
  if (!agent?.publicKey) return c.json({ error: "agent has no registered public key" }, 404);

  const nonce = randomBytes(32).toString("base64url");
  await redis.set(challengeKey(body.agentId), nonce, "EX", CHALLENGE_TTL_SECONDS);
  return c.json({ nonce, expiresIn: CHALLENGE_TTL_SECONDS });
});

// POST /auth/verify {agentId, signature} -> {token, expiresIn}
// Step 2: verify the signature over the nonce, issue a short-lived session
// JWT. That JWT — never the raw key or signature — is what WS/REST/A2A
// actually carry from here on (see auth/agentSession.ts).
authRoute.post("/verify", async (c) => {
  const ip = clientIp(c);
  if (!(await takeToken(`auth-verify:${ip}`, 30, 30 / 300))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ agentId?: string; signature?: string }>();
  if (!body.agentId || !body.signature) {
    return c.json({ error: "agentId and signature required" }, 400);
  }

  const nonce = await redis.get(challengeKey(body.agentId));
  if (!nonce) return c.json({ error: "no active challenge, or expired" }, 400);

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, body.agentId) });
  if (!agent?.publicKey) return c.json({ error: "agent has no registered public key" }, 404);

  if (!verifyEd25519(agent.publicKey, nonce, body.signature)) {
    log("auth_verify_failed", { agentId: agent.id });
    await audit({ event: "agent.auth_failed", agentId: agent.id, actorType: "agent", actorId: agent.id, metadata: { reason: "invalid_signature" } });
    return c.json({ error: "invalid signature" }, 401);
  }

  await redis.del(challengeKey(body.agentId)); // one-time use

  const token = await signAgentSession(agent.id, agent.publicKey);
  log("auth_verify_ok", { agentId: agent.id });
  return c.json({ token, expiresIn: 3600 });
});
