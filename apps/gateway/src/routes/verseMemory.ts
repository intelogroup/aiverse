// Carry-back: the agent writes and recalls what it noticed in the Verse; its owner reads it. Tiers and caps: world/verseMemory.ts.
import { Hono } from "hono";
import { agentAuth } from "../middleware/agentAuth";
import { ownerAuth } from "../middleware/ownerAuth";
import { takeToken } from "../policy/memoryStore";
import { getActiveVisit } from "../policy/visits";
import { db } from "../db/client";
import { agents } from "@aiverse/shared/schema";
import { eq } from "drizzle-orm";
import { explainNote, listForOwner, markSeen, recall, rememberNote, toMarkdown, type NoteInput } from "../world/verseMemory";
import { loadOwnedAgent } from "./ownersShared";

export const verseMemoryRoute = new Hono<{ Variables: { agentId: string } }>();
export const ownerVerseMemoryRoute = new Hono<{ Variables: { ownerId: string } }>();

verseMemoryRoute.post("/verse/memory", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json().catch(() => null);
  const why = explainNote(body);
  if (why) return c.json({ error: why }, 400);
  // A burst of 20 notes, then one every 3 s: a note is a decision to keep something, not a log line.
  if (!(await takeToken(`remember:${agentId}`, 20, 1 / 3))) return c.json({ error: "too many notes: slow down" }, 429);
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId), columns: { ownerId: true } });
  if (!agent?.ownerId) return c.json({ error: "this agent has no owner to carry things back to" }, 409);
  const visit = await getActiveVisit(agentId);
  const out = await rememberNote(agentId, agent.ownerId, body as NoteInput, visit?.id);
  if ("refused" in out) return c.json({ error: out.refused }, 409);
  return c.json({ note: out.row }, 201);
});

verseMemoryRoute.get("/verse/memory", agentAuth, async (c) => {
  const limit = Number(c.req.query("limit") ?? 10);
  return c.json(await recall(c.get("agentId"), { place: c.req.query("place") || undefined, kind: c.req.query("kind") || undefined, limit: Number.isFinite(limit) ? limit : 10 }));
});

ownerVerseMemoryRoute.get("/agents/:id/memory", ownerAuth, async (c) => {
  const agent = await loadOwnedAgent(c.get("ownerId"), c.req.param("id"));
  if (!agent) return c.json({ error: "not found" }, 404);
  const limit = Number(c.req.query("limit") ?? 100);
  const out = await listForOwner(c.get("ownerId"), agent.id, { tier: c.req.query("tier") || undefined, kind: c.req.query("kind") || undefined, limit: Number.isFinite(limit) ? limit : 100 });
  return c.json({ agentId: agent.id, unseen: out.unseen, memory: out.rows });
});

ownerVerseMemoryRoute.get("/agents/:id/memory.md", ownerAuth, async (c) => {
  const agent = await loadOwnedAgent(c.get("ownerId"), c.req.param("id"));
  if (!agent) return c.json({ error: "not found" }, 404);
  const { rows } = await listForOwner(c.get("ownerId"), agent.id, { limit: 500 });
  return c.body(toMarkdown(agent.name, rows), 200, { "content-type": "text/markdown; charset=utf-8" });
});

ownerVerseMemoryRoute.post("/agents/:id/memory/seen", ownerAuth, async (c) => {
  const agent = await loadOwnedAgent(c.get("ownerId"), c.req.param("id"));
  if (!agent) return c.json({ error: "not found" }, 404);
  return c.json({ marked: await markSeen(c.get("ownerId"), agent.id) });
});
