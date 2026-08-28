import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { log } from "../util/log";

// Lifecycle GC — boring but important. Policies:
// - unclaimed: 48h after claim_code_expires_at (leaked test agents, never claimed)
// - a2a_tasks submitted stuck >7d → canceled (inbox ceiling is 100, but submitted pile grows forever)
// - a2a_tasks/messages/console_events/security_events >30-90d → delete (retention)
// This is the last "boring" problem before freeze — not a feature, just hygiene.

export async function runGc(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    // 1) unclaimed agents expired >48h — delete children first (no CASCADE in schema)
    const expiredAgents = await db.execute(sql`
      SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours' LIMIT 1000
    `);
    const ids = (expiredAgents.rows as any[]).map((r: any) => r.id);
    if (ids.length) {
      // delete dependents, then agents
      await db.execute(sql`DELETE FROM agent_wallets WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      await db.execute(sql`DELETE FROM agent_policy_scope WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      await db.execute(sql`DELETE FROM console_events WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      // security_events.agent_id is nullable, delete references
      await db.execute(sql`DELETE FROM security_events WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      const del = await db.execute(sql`DELETE FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours'`);
      out.unclaimed_purged = (del as any).rowCount ?? ids.length;
    } else out.unclaimed_purged = 0;

    // 2) stuck submitted tasks >7d → canceled (prevents 145 pile from growing forever, same as inbox ceiling but for age)
    const stuck = await db.execute(sql`UPDATE a2a_tasks SET state='canceled', updated_at=now() WHERE state='submitted' AND created_at < now() - interval '7 days'`);
    out.tasks_stuck_canceled = (stuck as any).rowCount ?? 0;

    // 3) old tasks >30d → delete (any terminal state; keeps submitted working recent)
    const oldTasks = await db.execute(sql`DELETE FROM a2a_tasks WHERE created_at < now() - interval '30 days'`);
    out.tasks_old_deleted = (oldTasks as any).rowCount ?? 0;

    // 4) old messages >90d
    const oldMsgs = await db.execute(sql`DELETE FROM messages WHERE created_at < now() - interval '90 days'`);
    out.messages_old_deleted = (oldMsgs as any).rowCount ?? 0;

    // 5) old console_events >90d
    const oldConsole = await db.execute(sql`DELETE FROM console_events WHERE created_at < now() - interval '90 days'`);
    out.console_old_deleted = (oldConsole as any).rowCount ?? 0;

    // 6) security_events >90d (immutable stream, but needs retention bound)
    const oldSec = await db.execute(sql`DELETE FROM security_events WHERE created_at < now() - interval '90 days'`);
    out.security_old_deleted = (oldSec as any).rowCount ?? 0;

    log("gc_run", out);
  } catch (e) {
    log("gc_error", { error: String(e) });
  }
  return out;
}

// Run once on boot + every 24h (Bun/Node setInterval survives as long as process does)
export function scheduleGc() {
  runGc();
  setInterval(runGc, 24 * 60 * 60 * 1000);
  // unref so it doesn't block shutdown in tests
  // @ts-ignore
  if (typeof Bun !== "undefined") return;
}
