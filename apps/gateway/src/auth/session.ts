import { sign, verify } from "hono/jwt";
import { env } from "@aiverse/shared/env";

const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7;

export function signOwnerSession(ownerId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ONE_WEEK_SECONDS;
  return sign({ sub: ownerId, exp }, env.JWT_SECRET);
}

export async function verifyOwnerSession(token: string): Promise<string> {
  const payload = await verify(token, env.JWT_SECRET, "HS256");
  return payload.sub as string;
}
