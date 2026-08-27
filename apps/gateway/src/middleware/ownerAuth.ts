import type { MiddlewareHandler } from "hono";
import { verifyOwnerSession } from "../auth/session";

export const ownerAuth: MiddlewareHandler<{ Variables: { ownerId: string } }> = async (
  c,
  next,
) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const ownerId = await verifyOwnerSession(token);
    c.set("ownerId", ownerId);
    await next();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
};
