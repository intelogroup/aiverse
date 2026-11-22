import { Hono } from "hono";
import { adminAuth } from "../middleware/adminAuth";
import { statusWindow } from "../util/metrics";
import { getConnectedAgentIds } from "../ws/gateway";
import type { SimClient } from "../world/simClient";

const bootedAt = Date.now();

// GET /admin/metrics — operator view of "trouble before agents see it": this process plus the sim's own /stats, proxied.
// `sim` is the sim's stats object, or a string: "unreachable" (timeout / non-200 / bad JSON) or "not_configured" (no sim client).
export function createAdminMetricsRoute(sim: SimClient | null) {
  const route = new Hono<{ Variables: { ownerId: string } }>();
  route.get("/metrics", adminAuth, async (c) => {
    let simStats: unknown = "not_configured";
    if (sim) {
      simStats = await sim.call("GET", "/stats").then((r) => (r.ok ? r.json() : "unreachable")).catch(() => "unreachable");
    }
    return c.json({
      gateway: {
        uptimeS: Math.round((Date.now() - bootedAt) / 1000),
        rssMb: Math.round(process.memoryUsage.rss() / 1048576),
        wsAgents: getConnectedAgentIds().length,
        windowS: 60,
        requests: statusWindow(),
      },
      sim: simStats,
    });
  });
  return route;
}
