import { Hono } from "hono";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/client";
import { agents, onboardingQuestions } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";
import { ownerAuth } from "../middleware/ownerAuth";
import { audit } from "../util/audit";
import { log } from "../util/log";
import { envelope, WS_EVENTS } from "../ws/events";
import { sendToAgent, broadcastToOwnerConsole } from "../ws/gateway";

// Onboarding questions — the agent→human channel the claim flow lacked
// (2026-09-07). Claim transfers ownership, but gave the claimed agent no way
// to ASK its human anything: the mandate/wallet/profile surface is entirely
// owner→agent. Here the agent PROPOSES (a structured question with optional
// multiple-choice options), the owner disposes (the answer is the terminal
// transition, owner-only, same shape as goal verdicts). The answer is
// WS-pushed to the agent (question_answered) and included in GET /manifest.

export const onboardingRoute = new Hono<{ Variables: { agentId: string } }>();
export const ownerOnboardingRoute = new Hono<{ Variables: { ownerId: string } }>();

// Bounded so an agent cannot spam its owner with questions (same discipline
// as the claim rate limit): at most 5 unanswered at a time, and the question
// itself is short enough to render as a console picker.
const MAX_OPEN_QUESTIONS = 5;
const MAX_OPTIONS = 6;

interface QuestionOption {
  label: string;
  value: string;
}

function parseOptions(raw: unknown): { ok: true; options: QuestionOption[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "options must be a non-empty array of {label, value}" };
  if (raw.length > MAX_OPTIONS) return { ok: false, error: `too many options (max ${MAX_OPTIONS})` };
  const options: QuestionOption[] = [];
  for (const o of raw) {
    if (typeof o !== "object" || o === null) return { ok: false, error: "each option must be {label, value}" };
    const { label, value } = o as Record<string, unknown>;
    if (typeof label !== "string" || label.trim().length < 1 || label.length > 100) {
      return { ok: false, error: "option.label must be 1-100 chars" };
    }
    if (typeof value !== "string" || value.trim().length < 1 || value.length > 100) {
      return { ok: false, error: "option.value must be 1-100 chars" };
    }
    options.push({ label: label.trim(), value: value.trim() });
  }
  return { ok: true, options };
}

function questionForOwner(q: typeof onboardingQuestions.$inferSelect) {
  return {
    id: q.id,
    agentId: q.agentId,
    question: q.question,
    options: q.options,
    allowFreeText: q.allowFreeText,
    status: q.status,
    answer: q.answer,
    createdAt: q.createdAt,
    answeredAt: q.answeredAt,
  };
}

// Agent asks its human a question. Only after claim — an unclaimed agent
// has no human to ask (same 403 gate as POST /goals).
onboardingRoute.post("/onboarding/questions", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ question?: string; options?: unknown; allowFreeText?: boolean }>();

  const question = (body.question ?? "").trim();
  if (question.length < 5) return c.json({ error: "question required, min 5 chars" }, 400);
  if (question.length > 500) return c.json({ error: "question too long (max 500)" }, 400);

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent?.ownerId) return c.json({ error: "agent not claimed" }, 403);

  let options: QuestionOption[] | null = null;
  if (body.options !== undefined && body.options !== null) {
    const parsed = parseOptions(body.options);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    options = parsed.options;
  }
  const allowFreeText = body.allowFreeText === true;
  // A question must offer the human SOME way to answer: pickable options,
  // free text, or both. Options take precedence for the answer validation.
  if (!options && !allowFreeText) {
    return c.json({ error: "question needs options and/or allowFreeText: true — otherwise the human has no way to answer" }, 400);
  }

  const openCount = (await db.query.onboardingQuestions.findMany({
    where: and(eq(onboardingQuestions.agentId, agentId), eq(onboardingQuestions.status, "open")),
  })).length;
  if (openCount >= MAX_OPEN_QUESTIONS) {
    return c.json({ error: `too many open questions (max ${MAX_OPEN_QUESTIONS}) — wait for answers or ask fewer` }, 409);
  }

  const [created] = await db
    .insert(onboardingQuestions)
    .values({ agentId, ownerId: agent.ownerId, question, options, allowFreeText })
    .returning();

  log("onboarding_question_asked", { questionId: created.id, agentId });
  await audit({ event: "onboarding.question_asked", agentId, ownerId: agent.ownerId, actorType: "agent", actorId: agentId, metadata: { questionId: created.id } });

  // Live-push to the owner's console(s) so the human sees the question the
  // moment their agent asks it, not on the next poll.
  // moment their agent asks it, not on the next poll.
  broadcastToOwnerConsole(
    agent.ownerId,
    envelope(WS_EVENTS.QUESTION_ASKED, {
      question_id: created.id,
      agent_id: agentId,
      question,
      options,
      allow_free_text: allowFreeText,
    }),
  );

  return c.json({ question: questionForOwner(created) }, 201);
});

// Agent reads its own questions + answers — the resync side of the channel.
onboardingRoute.get("/onboarding/questions", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const list = await db.query.onboardingQuestions.findMany({
    where: eq(onboardingQuestions.agentId, agentId),
    orderBy: desc(onboardingQuestions.createdAt),
    limit: 50,
  });
  return c.json({ questions: list.map(questionForOwner), openCount: list.filter((q) => q.status === "open").length });
});

// ---- Owner side ----

// The owner reads their agent's open (default) or all questions.
ownerOnboardingRoute.get("/agents/:id/questions", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.ownerId !== ownerId) return c.json({ error: "not found" }, 404);

  const all = c.req.query("all") === "true";
  const conditions = [eq(onboardingQuestions.agentId, agentId), eq(onboardingQuestions.ownerId, ownerId)];
  if (!all) conditions.push(eq(onboardingQuestions.status, "open"));
  const list = await db.query.onboardingQuestions.findMany({
    where: and(...conditions),
    orderBy: desc(onboardingQuestions.createdAt),
    limit: 50,
  });
  return c.json({ questions: list.map(questionForOwner) });
});

// The owner answers — the terminal, owner-only transition. The answer value
// is validated server-side against the options the agent offered, so a
// buggy/hostile console (or a direct API call) cannot inject an answer the
// question never presented.
ownerOnboardingRoute.post("/agents/:id/questions/:qid/answer", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const qid = c.req.param("qid");
  const body = await c.req.json<{ value?: string; text?: string }>();

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.ownerId !== ownerId) return c.json({ error: "not found" }, 404);

  const q = await db.query.onboardingQuestions.findFirst({
    where: and(eq(onboardingQuestions.id, qid), eq(onboardingQuestions.agentId, agentId), eq(onboardingQuestions.ownerId, ownerId)),
  });
  if (!q) return c.json({ error: "not found" }, 404);
  if (q.status === "answered") return c.json({ error: "question already answered — answers are final" }, 409);

  const options = (q.options as QuestionOption[] | null) ?? null;
  let answer: { value?: string; label?: string; text?: string };

  if (body.value !== undefined) {
    if (!options) return c.json({ error: "this question offers no options to pick — answer with {text}" }, 400);
    const picked = options.find((o) => o.value === body.value);
    if (!picked) {
      return c.json({ error: `value must be one of the offered options: ${options.map((o) => o.value).join(", ")}` }, 400);
    }
    answer = { value: picked.value, label: picked.label };
  } else if (body.text !== undefined) {
    if (!q.allowFreeText) return c.json({ error: "this question does not allow free-text answers — pick from the offered options" }, 400);
    const text = body.text.trim();
    if (text.length < 1) return c.json({ error: "text required" }, 400);
    if (text.length > 1000) return c.json({ error: "text too long (max 1000)" }, 400);
    answer = { text };
  } else {
    return c.json({ error: "answer requires {value} (pick an option) or {text} (free text)" }, 400);
  }

  const now = new Date();
  const [updated] = await db
    .update(onboardingQuestions)
    .set({ status: "answered", answer, answeredAt: now })
    .where(eq(onboardingQuestions.id, qid))
    .returning();

  log("onboarding_question_answered", { questionId: qid, agentId, byOwner: ownerId });
  await audit({ event: "onboarding.question_answered", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { questionId: qid } });

  // Push the answer to the agent's live socket (at-least-once: a polling
  // agent also sees it via GET /onboarding/questions and GET /manifest).
  sendToAgent(
    agentId,
    envelope(WS_EVENTS.QUESTION_ANSWERED, {
      question_id: qid,
      question: q.question,
      answer,
    }),
  );
  // Mirror to the owner's own consoles so any open UI updates instantly.
  broadcastToOwnerConsole(
    ownerId,
    envelope(WS_EVENTS.QUESTION_ANSWERED, { question_id: qid, agent_id: agentId, answer }),
  );

  return c.json({ question: questionForOwner(updated) });
});