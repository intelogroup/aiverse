import type { Context } from "hono";

// x-forwarded-for is a hop chain ("client, proxy1, proxy2") — the client's
// own IP is always the first entry. Using the raw header as a rate-limit key
// is wrong: intermediate hops (e.g. which Cloudflare edge node handled this
// specific request) can vary request-to-request, silently splitting one
// client across many buckets and defeating the limit entirely.
export function clientIp(c: Context): string {
  const header = c.req.header("x-forwarded-for");
  if (!header) return "unknown";
  return header.split(",")[0].trim() || "unknown";
}
