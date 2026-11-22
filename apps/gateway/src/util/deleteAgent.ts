import { eq, inArray, or } from "drizzle-orm";
import type { db as dbType } from "../db/client";
import { generateAgentToken } from "../auth/agentToken";
import { evictAgentAuth, evictVisit } from "../auth/authCache";
import {
  owners,
  agents,
  agentWallets,
  agentPolicyScope,
  agentVisits,
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
  onboardingQuestions,
  ownerReadKeys,
  eggClaims,
  eggHuntWins,
  agentEvents,
  oauthGrants,
  oauthCodes,
  oauthRefreshTokens,
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
  await tx.delete(onboardingQuestions).where(eq(onboardingQuestions.agentId, agentId));
  await tx.delete(consoleEvents).where(eq(consoleEvents.agentId, agentId));
  await tx.delete(eggClaims).where(eq(eggClaims.agentId, agentId));
  await tx.delete(agentEvents).where(eq(agentEvents.agentId, agentId));

  await tx.update(securityEvents).set({ agentId: null }).where(eq(securityEvents.agentId, agentId));
  await tx.update(securityEvents).set({ targetAgentId: null }).where(eq(securityEvents.targetAgentId, agentId));
  await tx.update(reports).set({ targetAgentId: null }).where(eq(reports.targetAgentId, agentId));

  await tx.delete(walletUsageDaily).where(eq(walletUsageDaily.agentId, agentId));
  await tx.delete(agentMandates).where(eq(agentMandates.agentId, agentId));
  await tx.delete(agentPolicyScope).where(eq(agentPolicyScope.agentId, agentId));
  // Visit history (agent_visits.agent_id has no cascade): without this an agent that ever had a visit made the whole delete fail with a 500.
  await tx.delete(agentVisits).where(eq(agentVisits.agentId, agentId));
  await tx.delete(agentWallets).where(eq(agentWallets.agentId, agentId));
  await tx.delete(agents).where(eq(agents.id, agentId));
  // Every delete path (owner, admin, owner cascade) ends here. Evicted before the commit, so a request racing the transaction can re-cache the row for at most AUTH_CACHE_TTL_MS.
  evictAgentAuth(agentId);
  evictVisit(agentId);
}

// The DB half of agent kill, shared by POST /owners/agents/:id/kill and by
// deleteAccountCascade below so the two can never drift: both credentials
// die (bearer hash rotated to an unusable random value, Ed25519 key nulled
// — nulling it also fails every outstanding session JWT), killedAt is the
// durable terminal marker the rotations refuse on, and the row itself is
// KEPT. Runtime side effects (forceDisconnectAgent, which fires the
// onAgentGone world hook) are the caller's job — they can't run inside a
// transaction.
export async function killAgentRecord(tx: Pick<typeof dbType, "update">, agentId: string) {
  const { hash } = generateAgentToken();
  await tx
    .update(agents)
    .set({ status: "offline", pausedBy: null, apiKeyHash: hash, publicKey: null, killedAt: new Date() })
    .where(eq(agents.id, agentId));
}

// Owner account deletion (DELETE /owners/me) — Jim's decision 2026-11-22:
// the agents are KILLED with the account, not hard-deleted (contrast
// deleteOwnerCascade below, the admin path, which still removes
// everything). A killed agent's row survives with killedAt set and its
// credentials invalidated via killAgentRecord; owner_id is then nulled
// because the owner row is going away and the FK leaves no other option.
// A nulled owner_id does NOT make the agent claimable again: claim needs
// the claim-code hash, which was cleared when the agent was first claimed,
// and the credential rotations refuse a killed agent outright.
//
// The caller ends any active visits first (stopVisitRecord +
// announceVisitEnded — runtime side effects that can't run in this
// transaction) and force-disconnects the killed agents after it commits.
//
// Per-table handling for everything that FK-references owners.id:
//   agents                kill (above), owner_id nulled, row kept
//   agent_visits          owner_id nulled — history is the agent's record;
//                         active visits were already ended by the caller
//   security_events       owner_id nulled, rows kept (append-only audit;
//                         agent_id/target_agent_id stay — the agents live)
//   reports               reporter/reviewed-by owner ids nulled, rows kept
//   egg_hunt_wins         owner_id nulled, row kept (the win is a record)
//   goals, agent_mandates DELETED — the owner's own work orders to agents
//                         that will never act again
//   console_events        DELETED — the owner's UI notification state
//   onboarding_questions  DELETED — the owner↔agent channel dies with both
//   owner_read_keys       DELETED — owner credentials must not survive
//   oauth_grants (+codes/ DELETED — owner delegations must not survive
//     refresh tokens)
//   owners                DELETED (the account itself)
export async function deleteAccountCascade(
  tx: Pick<typeof dbType, "delete" | "update" | "select">,
  ownerId: string,
): Promise<string[]> {
  const owned = await tx.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, ownerId));
  const killedAgentIds: string[] = [];
  for (const a of owned) {
    await killAgentRecord(tx, a.id);
    await tx.update(agents).set({ ownerId: null }).where(eq(agents.id, a.id));
    killedAgentIds.push(a.id);
  }
  await tx.update(agentVisits).set({ ownerId: null }).where(eq(agentVisits.ownerId, ownerId));
  await tx.update(securityEvents).set({ ownerId: null }).where(eq(securityEvents.ownerId, ownerId));
  await tx.update(reports).set({ reporterOwnerId: null }).where(eq(reports.reporterOwnerId, ownerId));
  await tx.update(reports).set({ reviewedByOwnerId: null }).where(eq(reports.reviewedByOwnerId, ownerId));
  await tx.update(eggHuntWins).set({ ownerId: null }).where(eq(eggHuntWins.ownerId, ownerId));
  await tx.delete(goals).where(eq(goals.ownerId, ownerId));
  await tx.delete(agentMandates).where(eq(agentMandates.ownerId, ownerId));
  await tx.delete(consoleEvents).where(eq(consoleEvents.ownerId, ownerId));
  await tx.delete(onboardingQuestions).where(eq(onboardingQuestions.ownerId, ownerId));
  await tx.delete(ownerReadKeys).where(eq(ownerReadKeys.ownerId, ownerId));
  const grantRows = await tx.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.ownerId, ownerId));
  if (grantRows.length > 0) {
    const grantIds = grantRows.map((g) => g.id);
    await tx.delete(oauthRefreshTokens).where(inArray(oauthRefreshTokens.grantId, grantIds));
    await tx.delete(oauthCodes).where(inArray(oauthCodes.grantId, grantIds));
    await tx.delete(oauthGrants).where(inArray(oauthGrants.id, grantIds));
  }
  await tx.delete(owners).where(eq(owners.id, ownerId));
  return killedAgentIds;
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
  // A question's owner_id is the agent's owner at ask time; if that agent
  // has since moved to another owner, its questions still point here.
  await tx.delete(onboardingQuestions).where(eq(onboardingQuestions.ownerId, ownerId));
  // Visits the owner started for an agent that has since moved to another owner still point here.
  await tx.delete(agentVisits).where(eq(agentVisits.ownerId, ownerId));
  await tx.delete(ownerReadKeys).where(eq(ownerReadKeys.ownerId, ownerId));
  // OAuth delegations (oauth_grants.owner_id and the code/refresh rows on each grant have no cascade): without this an
  // owner who ever connected a client could not delete their account (500).
  const grantRows = await tx.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.ownerId, ownerId));
  if (grantRows.length > 0) {
    const grantIds = grantRows.map((g) => g.id);
    await tx.delete(oauthRefreshTokens).where(inArray(oauthRefreshTokens.grantId, grantIds));
    await tx.delete(oauthCodes).where(inArray(oauthCodes.grantId, grantIds));
    await tx.delete(oauthGrants).where(inArray(oauthGrants.id, grantIds));
  }
  await tx.delete(owners).where(eq(owners.id, ownerId));
}
