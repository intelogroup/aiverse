import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agentVisits } from "@aiverse/shared/schema";
import { isAgentOnline } from "../presence";
import { announceVisitEnded } from "../ws/gateway";
import { endVisitRecord } from "../policy/visits";
import { log, logError } from "../util/log";

// Belt-and-braces sweep for the one way a visit can need ending without any
// request ever arriving to trigger agentAuth's own check: the deadline or
// the action cap passed, but the agent (or anyone) simply stopped calling
// in — nothing would ever notice otherwise.
//
// Presence deliberately does NOT end visits (2026-11-11, the 50-agent
// loadtest): REST presence is a 180-second TTL refreshed by authenticated
// calls, so any agent that pauses longer than that reads "offline" — and
// the old sweep ended its visit and removed its body after 10 quiet
// minutes, in last-touch order, regardless of the visit's own deadline.
// A 50-agent fleet left idle lost 25 bodies that way while their visits
// had hours to run. A visit is the owner's envelope (deadline + cap); it
// ends when the envelope says so, not when the agent goes quiet. Presence
// still drives the online/offline status other surfaces report, and this
// sweep keeps the visit row's offlineSince marker current so owners can
// see how long an agent has been quiet — it just never acts on it.
// (The "presence_expired" end reason survives on historical rows only;
// nothing produces it anymore.)
export async function sweepVisits(): Promise<{ endedByDeadlineOrCap: number }> {
  let endedByDeadlineOrCap = 0;
  try {
    const active = await db.query.agentVisits.findMany({
      where: isNull(agentVisits.endedAt),
    });

    for (const visit of active) {
      if (visit.actionsUsed >= visit.maxActions || visit.endsAt.getTime() <= Date.now()) {
        const ended = await endVisitRecord(visit.id, visit.actionsUsed >= visit.maxActions ? "action_cap" : "time_expired");
        if (ended) {
          await announceVisitEnded(ended);
          endedByDeadlineOrCap++;
        }
        continue;
      }

      // Marker only: track how long the agent has been quiet (and clear
      // the marker when it is back), never end the visit for it.
      const online = await isAgentOnline(visit.agentId);
      if (online) {
        if (visit.offlineSince) {
          await db.update(agentVisits).set({ offlineSince: null }).where(eq(agentVisits.id, visit.id));
        }
      } else if (!visit.offlineSince) {
        await db.update(agentVisits).set({ offlineSince: new Date() }).where(eq(agentVisits.id, visit.id));
      }
    }

    if (endedByDeadlineOrCap) log("visits_swept", { endedByDeadlineOrCap, activeChecked: active.length });
  } catch (e) {
    logError("visits_sweep_error", e as Error);
  }
  return { endedByDeadlineOrCap };
}

// Env-tunable (2026-10-17, Neon compute bridge): the sweep SELECTs every
// interval even with zero active visits, which pins the Free-plan compute
// awake. While bridged it stretches alongside AIVERSE_LEADER_CHECK_MS;
// visit expiries land up to one interval late. Default is production.
const SWEEP_INTERVAL_MS = (() => {
  const v = Number(process.env.AIVERSE_VISITS_SWEEP_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();

export function scheduleVisitsSweep(): void {
  sweepVisits();
  setInterval(sweepVisits, SWEEP_INTERVAL_MS);
}
