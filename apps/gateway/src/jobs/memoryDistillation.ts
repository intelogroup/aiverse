import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agentMemory, visitDistillations } from "@aiverse/shared/schema";
import { log, logError } from "../util/log";
import {
  entryHashFor,
  loadVisitRecord,
  LlmDistiller,
  type Distiller,
} from "../policy/memoryDistillation";
import { selectEmbedder, type Embedder } from "../llm/embedder";
import { selectLLMProvider } from "./nativeAgents";

// Leader-only worker for the visit_distillations queue that endVisitRecord
// enqueues into (policy/visits.ts). Each pass claims a batch of due rows,
// distills the visit's record into permanent agent_memory entries, and
// settles the row. Everything here is failure-isolated from the visit
// lifecycle by design: the visit already ended before a row exists, and a
// distillation that throws only marks its own row failed (retryable up to
// MAX_DISTILLATION_ATTEMPTS total attempts, then terminally failed until
// someone intervenes) — it can never un-end, block, or error a visit.

export const MAX_DISTILLATION_ATTEMPTS = 3;
// A row stuck in "processing" (the claiming process died mid-distillation)
// becomes claimable again after this long.
const STALE_PROCESSING_MS = 10 * 60_000;
const BATCH_LIMIT = 10;

export interface DistillationDeps {
  distiller?: Distiller;
  // Pass null to force "no embedder" (entries written with NULL
  // embeddings); omit to use the env-configured production selection.
  embedder?: Embedder | null;
}

export async function processVisitDistillations(
  deps: DistillationDeps = {},
  limit = BATCH_LIMIT,
): Promise<{ done: number; failed: number; entries: number }> {
  const distiller = deps.distiller ?? new LlmDistiller(selectLLMProvider());
  const embedder = deps.embedder !== undefined ? deps.embedder : selectEmbedder();
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const due = or(
    eq(visitDistillations.status, "pending"),
    and(eq(visitDistillations.status, "failed"), lt(visitDistillations.attempts, MAX_DISTILLATION_ATTEMPTS)),
    and(eq(visitDistillations.status, "processing"), lt(visitDistillations.updatedAt, staleBefore)),
  );
  const candidates = await db.query.visitDistillations.findMany({
    where: due,
    orderBy: asc(visitDistillations.createdAt),
    limit,
  });

  let done = 0;
  let failed = 0;
  let entries = 0;
  for (const row of candidates) {
    // Claim before working: the guarded status transition means two
    // passes (or a stale-processing reclaim racing the original worker)
    // never distill the same visit concurrently.
    const [claimed] = await db
      .update(visitDistillations)
      .set({
        status: "processing",
        attempts: sql`${visitDistillations.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(visitDistillations.id, row.id), due))
      .returning({ id: visitDistillations.id });
    if (!claimed) continue;

    try {
      const record = await loadVisitRecord(row.visitId);
      if (!record) throw new Error(`visit ${row.visitId} not found`);
      const texts = await distiller.distill(record);
      let vectors: (number[] | null)[] = texts.map(() => null);
      if (embedder && texts.length) vectors = await embedder.embed(texts);
      let written = 0;
      if (texts.length) {
        // Distilled entries join the agent's permanent memory as
        // "conclusion" rows (the existing memory vocabulary) carrying
        // their provenance. ON CONFLICT DO NOTHING on
        // (agentId, sourceVisitId, entryHash): a re-run of the same
        // distillation output inserts nothing twice.
        const inserted = await db
          .insert(agentMemory)
          .values(
            texts.map((content, i) => ({
              agentId: row.agentId,
              type: "conclusion",
              content,
              sourceVisitId: row.visitId,
              entryHash: entryHashFor(content),
              embedding: vectors[i] ?? null,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: agentMemory.id });
        written = inserted.length;
      }
      await db
        .update(visitDistillations)
        .set({ status: "done", entriesWritten: written, lastError: null, updatedAt: new Date() })
        .where(eq(visitDistillations.id, row.id));
      done++;
      entries += written;
    } catch (e) {
      await db
        .update(visitDistillations)
        .set({
          status: "failed",
          lastError: String((e as Error)?.message ?? e).slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(visitDistillations.id, row.id));
      logError("memory_distillation_failed", e as Error, { visitId: row.visitId, agentId: row.agentId });
      failed++;
    }
  }
  if (done || failed) log("memory_distillations_processed", { done, failed, entries });
  return { done, failed, entries };
}

// Env-tunable like the visits sweep (Neon compute bridge): the pass
// SELECTs every interval even with an empty queue.
const DISTILL_INTERVAL_MS = (() => {
  const v = Number(process.env.AIVERSE_MEMORY_DISTILL_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();

export function scheduleMemoryDistillation(): void {
  const run = () => {
    processVisitDistillations().catch((e) => logError("memory_distillation_sweep_error", e as Error));
  };
  run();
  setInterval(run, DISTILL_INTERVAL_MS);
}
