import { db } from "../db/client";
import { consoleEvents } from "@aiverse/shared/schema";
import { broadcastToOwnerConsole } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";

async function record(params: {
  agentId: string;
  ownerId: string;
  summary: string;
  severity: "attention" | "activity";
  refConversationId?: string;
}) {
  const [row] = await db
    .insert(consoleEvents)
    .values({
      agentId: params.agentId,
      ownerId: params.ownerId,
      severity: params.severity,
      summary: params.summary,
      refConversationId: params.refConversationId,
    })
    .returning();

  broadcastToOwnerConsole(params.ownerId, envelope(WS_EVENTS.CONSOLE_EVENT, row));
}

export function recordAttentionEvent(params: {
  agentId: string;
  ownerId: string;
  summary: string;
  refConversationId?: string;
}) {
  return record({ ...params, severity: "attention" });
}

// No caller ever writes "activity"-severity events (only recordAttentionEvent
// is used) — a sibling recordActivityEvent existed here but was dead code,
// removed 2026-09-24. GET /owners/console-events?severity=activity still
// accepts the filter but will always return empty until something writes
// one; the "activity" enum value itself is left in the schema in case a
// real activity-logging feature lands later.
