import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { formatVectorLiteral, selectEmbedder, type Embedder } from "../llm/embedder";

// Semantic recall over an agent's OWN permanent memory (agent_memory).
// Per-agent isolation is a hard requirement, enforced in the query itself:
// the agent_id predicate is part of the same statement as the similarity
// ordering, so no code path through here can rank — or return — another
// agent's entries. Only rows that carry an embedding participate (entries
// written before an embedder was configured are invisible to recall until
// backfilled; the plain chronological reads are unaffected).
//
// Returns null when no embedder is configured, so the caller can say
// "recall is not configured" instead of silently returning recency order
// dressed up as relevance.

export interface RecalledMemory {
  id: string;
  content: string;
  type: string;
  createdAt: Date;
  score: number;
}

export async function recallMemories(
  agentId: string,
  query: string,
  k = 8,
  embedder?: Embedder | null,
): Promise<RecalledMemory[] | null> {
  const emb = embedder !== undefined ? embedder : selectEmbedder();
  if (!emb) return null;
  const [vec] = await emb.embed([query]);
  if (!vec) return [];
  const literal = formatVectorLiteral(vec);
  const rows = (await db.execute(sql`
    SELECT id, content, type, created_at, 1 - (embedding <=> ${literal}::vector) AS score
    FROM agent_memory
    WHERE agent_id = ${agentId} AND embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${k}
  `)) as unknown as { id: string; content: string; type: string; created_at: Date | string; score: number | string }[];
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    type: r.type,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    score: Number(r.score),
  }));
}
