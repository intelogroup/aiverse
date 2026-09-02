import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { owners } from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { verifyOwnerSession } from "../auth/session";

// Admin = an owner account whose email is on ADMIN_EMAILS. No separate role
// table yet — this is the minimum viable gate, not a permissions system.
export const adminAuth: MiddlewareHandler<{ Variables: { ownerId: string } }> = async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return c.json({ error: "unauthorized" }, 401);

  let ownerId: string;
  try {
    ownerId = await verifyOwnerSession(token);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }

  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner || !env.ADMIN_EMAILS.includes(owner.email.toLowerCase())) {
    return c.json({ error: "forbidden" }, 403);
  }

  c.set("ownerId", ownerId);
  await next();
};
