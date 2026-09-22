import type { Context } from "hono";

// Rate-limit key. The leftmost x-forwarded-for entry is client-controlled
// (proxies append, never overwrite), so trusting it lets any caller mint a
// fresh bucket per request. On Render, traffic always crosses Cloudflare,
// which overwrites cf-connecting-ip with the real peer — the only unspoofable
// source there. Elsewhere, fall back to the rightmost XFF hop: the one our
// nearest proxy appended.
export function clientIp(c: Context): string {
  if (process.env.RENDER === "true") {
    return c.req.header("cf-connecting-ip")?.trim() || "unknown";
  }
  const header = c.req.header("x-forwarded-for");
  if (!header) return "unknown";
  const hops = header.split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? "unknown";
}
