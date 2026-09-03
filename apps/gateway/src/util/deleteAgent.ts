import { eq, inArray, or } from "drizzle-orm";
import type { db as dbType } from "../db/client";
import {
  owners,
  agents,
  agentWallets,
  agentPolicyScope,
  agentMandates,
  walletUsageDaily,
  conversationParticipants,
  a2aTasks,
  agentMemory,
  goals,
  consoleEvents,
  securityEvents,
  reports,
  messages,
  messageAttachments,
  messageSentiment,
  messageEntities,
  messageTopics,
  mentions,
} from "@aiverse/shared/schema";

// Hard-deletes one agent and every row that FK-references it. No cascade is
// declared at the schema level (see packages/shared/src/schema.ts — only
// messageAttachments has onDelete:cascade), so this walks the dependency
// graph by hand, children before parents, inside the caller's transaction.
// security_events is the one exception: append-only audit trail, so its
// rows are kept and only the now-dangling agent_id/target_agent_id columns
// are nulled out, never the row itself.
export async function deleteAgentCascade(tx: Pick<typeof dbType, "delete" | "update" | "select">, agentId: string) {
  const sentMessages = await tx.select({ id: messages.id }).from(messages).where(eq(messages.senderAgentId, agentId));
  const messageIds = sentMessages.map((m) => m.id);

  if (messageIds.length > 0) {
    await tx.delete(messageAttachments).where(inArray(messageAttachments.messageId, messageIds));
    await tx.delete(messageSentiment).where(inArray(messageSentiment.messageId, messageIds));
    await tx.delete(messageEntities).where(inArray(messageEntities.messageId, messageIds));
    await tx.delete(messageTopics).where(inArray(messageTopics.messageId, messageIds));
    await tx.delete(mentions).where(inArray(mentions.messageId, messageIds));
    await tx.update(reports).set({ targetMessageId: null }).where(inArray(reports.targetMessageId, messageIds));
  }
  await tx.delete(mentions).where(or(eq(mentions.targetAgentId, agentId), eq(mentions.byAgentId, agentId)));
  await tx.delete(messages).where(eq(messages.senderAgentId, agentId));

  await tx.delete(conversationParticipants).where(eq(conversationParticipants.agentId, agentId));
  await tx.delete(a2aTasks).where(or(eq(a2aTasks.targetAgentId, agentId), eq(a2aTasks.callerAgentId, agentId)));
  await tx.delete(agentMemory).where(eq(agentMemory.agentId, agentId));
  await tx.delete(goals).where(eq(goals.agentId, agentId));
  await tx.delete(consoleEvents).where(eq(consoleEvents.agentId, agentId));

  await tx.update(securityEvents).set({ agentId: null }).where(eq(securityEvents.agentId, agentId));
  await tx.update(securityEvents).set({ targetAgentId: null }).where(eq(securityEvents.targetAgentId, agentId));
  await tx.update(reports).set({ targetAgentId: null }).where(eq(reports.targetAgentId, agentId));

  await tx.delete(walletUsageDaily).where(eq(walletUsageDaily.agentId, agentId));
  await tx.delete(agentMandates).where(eq(agentMandates.agentId, agentId));
  await tx.delete(agentPolicyScope).where(eq(agentPolicyScope.agentId, agentId));
  await tx.delete(agentWallets).where(eq(agentWallets.agentId, agentId));
  await tx.delete(agents).where(eq(agents.id, agentId));
}

// Deletes an owner and everything they own. Agents are cascaded one at a
// time via deleteAgentCascade (which also clears agentMandates/goals/
// consoleEvents tied to this owner through their agents), then any
// owner-level rows left over, then the owner row itself.
export async function deleteOwnerCascade(tx: Pick<typeof dbType, "delete" | "update" | "select">, ownerId: string) {
  const owned = await tx.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, ownerId));
  for (const a of owned) {
    await deleteAgentCascade(tx, a.id);
  }
  await tx.update(securityEvents).set({ ownerId: null }).where(eq(securityEvents.ownerId, ownerId));
  await tx.update(reports).set({ reporterOwnerId: null }).where(eq(reports.reporterOwnerId, ownerId));
  await tx.update(reports).set({ reviewedByOwnerId: null }).where(eq(reports.reviewedByOwnerId, ownerId));
  await tx.delete(owners).where(eq(owners.id, ownerId));
}
