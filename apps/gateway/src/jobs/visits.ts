import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agentVisits } from "@aiverse/shared/schema";
import { isAgentOnline } from "../presence";
import { announceVisitEnded } from "../ws/gateway";
import { endVisitRecord } from "../policy/visits";
import { log, logError } from "../util/log";

// Belt-and-braces sweep for the two ways a visit can need ending without any
// request ever arriving to trigger agentAuth's own check:
//   1. deadline/cap passed, but the agent (or anyone) simply stopped
//      calling in — nothing would ever notice otherwise.
//   2. the agent's own presence has lapsed for a sustained stretch: a closed
//      Claude Code session, Grok Bot hitting its weekly limit, a crashed
//      runtime. These all look identical from here — the agent just stops
//      showing up — so one signal (no presence key) covers all of them.
//      A single missed presence tick is normal (a slow poll, a heartbeat
//      gap); AGENT_OFFLINE_GRACE_MS is long enough to absorb that and short
//      enough that a visit doesn't sit "active" for hours after its agent
//      is plainly gone.
export const AGENT_OFFLINE_GRACE_MS = 10 * 60_000;

export async function sweepVisits(): Promise<{ endedByDeadlineOrCap: number; endedByPresence: number }> {
  let endedByDeadlineOrCap = 0;
  let endedByPresence = 0;
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

      const online = await isAgentOnline(visit.agentId);
      if (online) {
        if (visit.offlineSince) {
          await db.update(agentVisits).set({ offlineSince: null }).where(eq(agentVisits.id, visit.id));
        }
        continue;
      }

      if (!visit.offlineSince) {
        await db.update(agentVisits).set({ offlineSince: new Date() }).where(eq(agentVisits.id, visit.id));
        continue;
      }
      if (Date.now() - visit.offlineSince.getTime() >= AGENT_OFFLINE_GRACE_MS) {
        const ended = await endVisitRecord(visit.id, "presence_expired");
        if (ended) {
          await announceVisitEnded(ended);
          endedByPresence++;
        }
      }
    }

    if (endedByDeadlineOrCap || endedByPresence) log("visits_swept", { endedByDeadlineOrCap, endedByPresence, activeChecked: active.length });
  } catch (e) {
    logError("visits_sweep_error", e as Error);
  }
  return { endedByDeadlineOrCap, endedByPresence };
}

const SWEEP_INTERVAL_MS = 60_000;

export function scheduleVisitsSweep(): void {
  sweepVisits();
  setInterval(sweepVisits, SWEEP_INTERVAL_MS);
}
