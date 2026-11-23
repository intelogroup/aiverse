import { createHash } from "node:crypto";
import { env } from "@aiverse/shared/env";

// Embeddings for agent memory (visit-end distillation + semantic recall).
// The dimension is fixed at 384 — the pgvector convention already set by
// messages.embedding (populated by the Python classifier worker with a
// 384-dim fastembed model). agent_memory.embedding is the same width, so
// any provider wired here must serve 384-dim vectors; HttpEmbedder
// refuses anything else rather than letting Postgres reject the insert
// mid-distillation.
export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

// OpenAI-shaped embeddings endpoint (POST {url} {model, input} ->
// {data: [{index, embedding}]}). The URL is the full endpoint, read from
// MEMORY_EMBEDDING_URL — the same env-first pattern the LLM providers use
// for their keys. No default endpoint: an unconfigured deployment gets
// selectEmbedder() === null and memory simply ships without embeddings.
export class HttpEmbedder implements Embedder {
  constructor(
    private url: string,
    private apiKey: string | undefined,
    private model: string | undefined,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...(this.model ? { model: this.model } : {}), input: texts }),
    });
    if (!res.ok) throw new Error(`embedding endpoint returned ${res.status}`);
    const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(body.data) || body.data.length !== texts.length) {
      throw new Error("embedding endpoint returned a malformed response");
    }
    const out = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const v of out) {
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${Array.isArray(v) ? v.length : "non-array"}`);
      }
    }
    return out;
  }
}

// Deterministic stand-in for tests: a hashed bag-of-words vector. Texts
// that share words land near each other under cosine similarity, which is
// the only property recall ranking tests need; identical input always
// yields the identical vector, so tests never flake on a provider.
export class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t));
  }
}

export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token) continue;
    const digest = createHash("sha256").update(token).digest();
    v[digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

// The production selection: an embedder only exists when the operator has
// configured an endpoint. Callers treat null as "embeddings off" —
// distillation still writes its entries (with NULL embeddings) and recall
// reports itself unconfigured.
export function selectEmbedder(): Embedder | null {
  if (!env.MEMORY_EMBEDDING_URL) return null;
  return new HttpEmbedder(env.MEMORY_EMBEDDING_URL, env.MEMORY_EMBEDDING_API_KEY, env.MEMORY_EMBEDDING_MODEL);
}

// pgvector's text literal form, for raw-SQL similarity queries.
export function formatVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
