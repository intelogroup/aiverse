import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { verseCabinInvitations as invites } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { getActiveVisit } from "../policy/visits";
import type { SimClient } from "../world/simClient";

export const cabinInvitationsEnabled = () => process.env.AIVERSE_CABIN_INVITATIONS === "1";
const speechInput = z.object({ actId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }).strict();
type Invitation = typeof invites.$inferSelect;

function view(invitation: Invitation, agentId: string) {
  const { id, deliveredAt, acceptedAt, expiresAt, hostArrivedAt, guestArrivedAt } = invitation;
  const role = invitation.hostId === agentId ? "host" : "guest";
  const status = hostArrivedAt && guestArrivedAt ? "both_arrived" : expiresAt.getTime() <= Date.now() ? "expired" :
    acceptedAt ? "accepted" : "delivered";
  return { id, role, place: "house-cabin-1", placeName: "Stone Cabin", status, deliveredAt, acceptedAt, expiresAt, hostArrivedAt, guestArrivedAt };
}

function party(agentId: string, visitId?: string) {
  return or(
    and(eq(invites.hostId, agentId), visitId ? eq(invites.hostVisitId, visitId) : undefined),
    and(eq(invites.guestId, agentId), visitId ? eq(invites.guestVisitId, visitId) : undefined),
  );
}

export async function listCabinInvitations(agentId: string, visitId?: string) {
  const rows = await db.select().from(invites).where(party(agentId, visitId))
    .orderBy(desc(invites.deliveredAt), desc(invites.id)).limit(20);
  return rows.map((row) => view(row, agentId));
}

export function createCabinInvitationRoute(sim: SimClient) {
  const route = new Hono<{ Variables: { agentId: string; visitId: string; visitEndsAt: number } }>();
  route.get("/", async (c) => c.json({ invitations: await listCabinInvitations(c.get("agentId"), c.get("visitId")) }));

  route.post("/", async (c) => {
    const parsed = speechInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_speech_act" }, 400);
    const { actId } = parsed.data;
    const hostId = c.get("agentId"), hostVisitId = c.get("visitId");
    const speech = and(eq(invites.hostVisitId, hostVisitId), eq(invites.actId, actId));
    const [existing] = await db.select().from(invites).where(speech);
    if (existing) return c.json({ invitation: view(existing, hostId) });
    const proof = await sim.call("GET", `/bodies/${hostId}/cabin-invitation-proof/${actId}`).catch(() => null);
    if (!proof?.ok) return c.json({ error: "speech_proof_unavailable" }, 503);
    const recipient = z.object({ recipient: z.uuid().nullable() }).safeParse(await proof.json().catch(() => null));
    if (!recipient.success) return c.json({ error: "speech_proof_unavailable" }, 503);
    const guestId = recipient.data.recipient;
    if (!guestId || guestId === hostId) return c.json({ error: "invitation_not_heard" }, 409);
    const guest = await getActiveVisit(guestId);
    const now = Date.now();
    if (!guest || guest.endsAt.getTime() <= now || guest.actionsUsed >= guest.maxActions) {
      return c.json({ error: "guest_unavailable" }, 409);
    }
    const expiresAt = new Date(Math.min(now + 120_000, guest.endsAt.getTime(), c.get("visitEndsAt")));
    if (expiresAt.getTime() <= now) return c.json({ error: "invitation_expired" }, 409);
    const [created] = await db.insert(invites).values({
      hostId, guestId, hostVisitId, guestVisitId: guest.id, actId, expiresAt,
    }).onConflictDoNothing({ target: [invites.hostVisitId, invites.actId] }).returning();
    if (created) return c.json({ invitation: view(created, hostId) }, 201);
    const [retry] = await db.select().from(invites).where(speech);
    return retry ? c.json({ invitation: view(retry, hostId) }) : c.json({ error: "invitation_unavailable" }, 409);
  });

  route.post("/:id/:step", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const step = z.enum(["accept", "arrive"]).safeParse(c.req.param("step"));
    if (!id.success || !step.success) return c.json({ error: "invalid_invitation" }, 400);
    const agentId = c.get("agentId"), visitId = c.get("visitId");
    const own = and(eq(invites.id, id.data), party(agentId, visitId));
    const [invitation] = await db.select().from(invites).where(own);
    if (!invitation) return c.json({ error: "invitation_not_found" }, 404);
    const host = invitation.hostId === agentId;
    const current = view(invitation, agentId);
    const open = sql`${invites.expiresAt} > clock_timestamp()`;
    const timestamp = sql`clock_timestamp()`;
    if (step.data === "accept") {
      if (host) return c.json({ error: "guest_required" }, 403);
      if (invitation.acceptedAt) return c.json({ invitation: current });
      const [accepted] = await db.update(invites).set({ acceptedAt: timestamp }).where(and(own, open, isNull(invites.acceptedAt))).returning();
      const latest = accepted ?? (await db.select().from(invites).where(own))[0];
      return latest?.acceptedAt ? c.json({ invitation: view(latest, agentId) }) : c.json({ error: "invitation_expired" }, 409);
    }
    if (host ? invitation.hostArrivedAt : invitation.guestArrivedAt) return c.json({ invitation: current });
    if (current.status === "expired") return c.json({ error: "invitation_expired" }, 409);
    if (!invitation.acceptedAt) return c.json({ error: "acceptance_required" }, 409);
    const proof = await sim.call("GET", `/bodies/${agentId}/cabin-arrival`).catch(() => null);
    if (proof?.status === 404) return c.json({ error: "cabin_arrival_required" }, 409);
    if (!proof?.ok) return c.json({ error: "cabin_proof_unavailable" }, 503);
    const location = z.object({ inside: z.boolean() }).safeParse(await proof.json().catch(() => null));
    if (!location.success) return c.json({ error: "cabin_proof_unavailable" }, 503);
    if (!location.data.inside) return c.json({ error: "cabin_arrival_required" }, 409);
    const [arrived] = await db.update(invites).set(host ? { hostArrivedAt: timestamp } : { guestArrivedAt: timestamp })
      .where(and(own, open, isNotNull(invites.acceptedAt), isNull(host ? invites.hostArrivedAt : invites.guestArrivedAt))).returning();
    const latest = arrived ?? (await db.select().from(invites).where(own))[0];
    if (!latest || !(host ? latest.hostArrivedAt : latest.guestArrivedAt)) return c.json({ error: "invitation_expired" }, 409);
    return c.json({ invitation: view(latest, agentId) });
  });
  return route;
}
