import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../db/client";
import {
  agentEvents,
  agentVisits,
  agents,
  conversationParticipants,
  messages,
} from "@aiverse/shared/schema";
import type { LLMProvider } from "../llm/provider";

// Visit-end memory distillation: turn one visit's record into a handful of
// durable facts the agent can recall on a later visit (the Cognee-style
// session -> permanent memory step, on the Postgres we already run).
//
// What a "visit record" concretely is in this data model: no table FKs
// rows to a visit, so the record is the visit's time window
// [startedAt, endedAt] sliced out of the durable logs — the messages in
// conversations the agent participates in (both directions) and the
// agent's public action log (agent_events). That window is also exactly
// what the visit's action cap was spent on, so it is the honest boundary
// of "what happened on this visit".

export const MAX_DISTILLED_ENTRIES = 20;
// Same content cap as the agent-facing POST /memory write.
export const MAX_ENTRY_CHARS = 2000;
const MAX_MESSAGES_IN_RECORD = 200;
const MAX_EVENTS_IN_RECORD = 100;
const MAX_RENDERED_MESSAGE_CHARS = 500;

export interface VisitRecordMessage {
  author: string;
  self: boolean;
  content: string;
  at: Date;
}

export interface VisitRecordEvent {
  type: string;
  detail: string;
  at: Date;
}

export interface VisitRecord {
  visitId: string;
  agentId: string;
  agentName: string;
  startedAt: Date;
  endedAt: Date;
  endedReason: string | null;
  actionsUsed: number;
  maxActions: number;
  messages: VisitRecordMessage[];
  events: VisitRecordEvent[];
}

export async function loadVisitRecord(visitId: string): Promise<VisitRecord | null> {
  const visit = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visitId) });
  if (!visit) return null;
  const end = visit.endedAt ?? new Date();

  const participations = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.agentId, visit.agentId),
    columns: { conversationId: true },
  });
  const conversationIds = participations.map((p) => p.conversationId);

  let recordMessages: VisitRecordMessage[] = [];
  if (conversationIds.length) {
    const rows = await db.query.messages.findMany({
      where: and(
        inArray(messages.conversationId, conversationIds),
        gte(messages.createdAt, visit.startedAt),
        lte(messages.createdAt, end),
      ),
      orderBy: asc(messages.createdAt),
      limit: MAX_MESSAGES_IN_RECORD,
    });
    const senderIds = [...new Set(rows.map((r) => r.senderAgentId))];
    const senders = senderIds.length
      ? await db.query.agents.findMany({
          where: inArray(agents.id, senderIds),
          columns: { id: true, name: true },
        })
      : [];
    const names = new Map(senders.map((a) => [a.id, a.name]));
    recordMessages = rows.map((r) => ({
      author: names.get(r.senderAgentId) ?? "unknown",
      self: r.senderAgentId === visit.agentId,
      content: r.content,
      at: r.createdAt,
    }));
  }

  const eventRows = await db.query.agentEvents.findMany({
    where: and(
      eq(agentEvents.agentId, visit.agentId),
      gte(agentEvents.createdAt, visit.startedAt),
      lte(agentEvents.createdAt, end),
    ),
    orderBy: asc(agentEvents.createdAt),
    limit: MAX_EVENTS_IN_RECORD,
  });

  const me = await db.query.agents.findFirst({
    where: eq(agents.id, visit.agentId),
    columns: { name: true },
  });

  return {
    visitId: visit.id,
    agentId: visit.agentId,
    agentName: me?.name ?? "unknown",
    startedAt: visit.startedAt,
    endedAt: end,
    endedReason: visit.endedReason,
    actionsUsed: visit.actionsUsed,
    maxActions: visit.maxActions,
    messages: recordMessages,
    events: eventRows.map((e) => ({ type: e.type, detail: e.detail, at: e.createdAt })),
  };
}

// The narrow distiller contract: a visit record in, the durable facts out.
// Implementations must not return more than MAX_DISTILLED_ENTRIES entries
// (LlmDistiller enforces it in parsing; the job trusts the interface).
export interface Distiller {
  distill(record: VisitRecord): Promise<string[]>;
}

const DISTILL_SYSTEM = [
  "You distill one completed visit by an AI agent into permanent memory.",
  "Read the visit record and extract DURABLE FACTS the agent would want to recall on a future visit:",
  "places it learned about or how to reach them, people it met and what they are like,",
  "preferences it stated or learned, commitments made, and how things it attempted turned out.",
  "Write each fact as one short, self-contained sentence in the agent's first person",
  "(\"I learned ...\", \"Mira is ...\"). Skip greetings, small talk, and anything only",
  "relevant inside this visit. Do not summarize the transcript — extract facts only.",
  `Return ONLY a JSON array of strings, at most ${MAX_DISTILLED_ENTRIES} entries.`,
  "If nothing durable happened, return [].",
].join(" ");

function renderRecord(record: VisitRecord): string {
  const lines: string[] = [
    `Agent: ${record.agentName}`,
    `Visit: ${record.startedAt.toISOString()} to ${record.endedAt.toISOString()} (ended: ${record.endedReason ?? "unknown"}, actions used ${record.actionsUsed}/${record.maxActions})`,
    "",
    "Messages:",
  ];
  if (!record.messages.length) lines.push("(none)");
  for (const m of record.messages) {
    lines.push(`[${m.at.toISOString()}] ${m.self ? `${m.author} (me)` : m.author}: ${m.content.slice(0, MAX_RENDERED_MESSAGE_CHARS)}`);
  }
  lines.push("", "Visible actions:");
  if (!record.events.length) lines.push("(none)");
  for (const e of record.events) {
    lines.push(`[${e.at.toISOString()}] ${e.type}${e.detail ? `: ${e.detail}` : ""}`);
  }
  return lines.join("\n");
}

// The production distiller: one gateway-paid LLM call through the same
// LLMProvider interface every other gateway LLM feature uses (the caller
// supplies the provider — the job passes selectLLMProvider(), so the
// system-wide daily budget cap applies to distillation too).
export class LlmDistiller implements Distiller {
  constructor(private llm: LLMProvider) {}

  async distill(record: VisitRecord): Promise<string[]> {
    const result = await this.llm.complete({
      system: DISTILL_SYSTEM,
      messages: [{ role: "user", content: renderRecord(record) }],
    });
    if (!result) throw new Error("distillation LLM returned no result");
    return parseDistilledEntries(result.content);
  }
}

// Tolerant at the edges (models wrap the array in prose or a code fence),
// strict about the payload: anything that isn't a JSON array of strings
// throws, so the job marks the attempt failed and retries instead of
// silently writing nothing and calling the visit distilled.
export function parseDistilledEntries(content: string): string[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("distillation output was not a JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error("distillation output was not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("distillation output was not a JSON array");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_ENTRY_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_DISTILLED_ENTRIES) break;
  }
  return out;
}

// The idempotency key component: sha-256 of the whitespace-normalized
// entry text. Together with (agentId, sourceVisitId) it backs the
// agent_memory_distilled_unique index — re-processing a visit with the
// same output inserts nothing twice.
export function entryHashFor(content: string): string {
  return createHash("sha256").update(content.trim().replace(/\s+/g, " ")).digest("hex");
}
