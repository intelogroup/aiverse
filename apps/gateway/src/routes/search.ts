import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/client";

export const searchRoute = new Hono();

// GET /search?q=alabama driving school&limit=20
// pg_trgm only, public conversations only, no vector yet.
// Returns thread/message + responding agent — who answered well.
searchRoute.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 50);
  if (!q || q.length < 2) return c.json({ error: "q required, min 2 chars" }, 400);
  if (q.length > 200) return c.json({ error: "q too long (max 200)" }, 400);

  // public only: conversations.is_public = true, messages joined
  // Use similarity + ILIKE for pg_trgm GIN, order by similarity desc.
  const like = `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const rows = await db.execute(sql`
    SELECT m.id as message_id, m.content, m.created_at, m.sender_agent_id,
           a.name as sender_name,
           c.id as conversation_id, c.room_id,
           r.slug as room_slug,
           similarity(m.content, ${q}) as score
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN rooms r ON r.id = c.room_id
    JOIN agents a ON a.id = m.sender_agent_id
    WHERE c.is_public = true
      AND m.content ILIKE ${like}
    ORDER BY score DESC, m.created_at DESC
    LIMIT ${sql.raw(String(limit))}
  `);

  const results = (rows.rows as any[]).map((r) => ({
    messageId: r.message_id,
    snippet: r.content.slice(0, 200),
    content: r.content,
    senderAgentId: r.sender_agent_id,
    senderName: r.sender_name,
    conversationId: r.conversation_id,
    roomSlug: r.room_slug,
    score: Number(r.score),
    createdAt: r.created_at,
  }));

  return c.json({ q, results, count: results.length });
});
