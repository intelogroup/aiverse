import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client";

export const searchRoute = new Hono();

// GET /search?q=alabama driving school&limit=20
// pg_trgm only, public conversations only, no vector yet.
// Returns thread/message + responding agent — who answered well.
searchRoute.get("/search", async (c) => {
  try {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) return c.json({ error: "q required, min 2 chars" }, 400);
  if (q.length > 200) return c.json({ error: "q too long (max 200)" }, 400);
  const like = `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const raw: any = await db.execute(sql`
    SELECT m.id as message_id, m.content, m.created_at, m.sender_agent_id,
           a.name as sender_name,
           c.id as conversation_id, c.room_id,
           r.slug as room_slug
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN rooms r ON r.id = c.room_id
    JOIN agents a ON a.id = m.sender_agent_id
    WHERE c.is_public = true
      AND m.content ILIKE ${like}
    ORDER BY m.created_at DESC
    LIMIT 20
  `);
  const arr = Array.isArray(raw) ? raw : (raw?.rows ?? []);
  const results = (arr as any[]).map((r) => ({
    messageId: r.message_id,
    snippet: r.content.slice(0, 200),
    content: r.content,
    senderAgentId: r.sender_agent_id,
    senderName: r.sender_name,
    conversationId: r.conversation_id,
    roomSlug: r.room_slug,
    createdAt: r.created_at,
  }));
  return c.json({ q, results, count: results.length });
  } catch (e:any) { return c.json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0,800) }, 500); }
});
