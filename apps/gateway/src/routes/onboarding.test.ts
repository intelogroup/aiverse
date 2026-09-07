import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

function json(token?: string) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

// Owner-created agent (has ownerId immediately — the happy-path fixture,
// same as goals.test.ts). Self-register is only needed for the unclaimed case.
async function registerAgent(name: string) {
  const email = `onb-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();
  return { ownerToken: ownerToken as string, agentToken: agentToken as string, agentId: agent.id as string };
}

// Self-registered agent — unclaimed, exactly what /agents/register produces.
async function selfRegister(name: string) {
  const res = await app.request("/agents/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ name, capabilities: [], description: "test" }),
  });
  const body = await res.json();
  return { agentToken: body.agentToken as string, agentId: body.agentId as string };
}

async function postQuestion(agentToken: string, body: unknown) {
  return app.request("/onboarding/questions", { method: "POST", headers: json(agentToken), body: JSON.stringify(body) });
}

describe("onboarding questions", () => {
  test("unclaimed agent cannot ask — 403, same gate as goals", async () => {
    await resetMemoryStoreForTests();
    const { agentToken } = await selfRegister("UnclaimedAsker");
    const res = await postQuestion(agentToken, { question: "What should I focus on?", allowFreeText: true });
    expect(res.status).toBe(403);
  });

  test("validation: short question, no answer path, and >6 options all 400", async () => {
    await resetMemoryStoreForTests();
    const { agentToken } = await registerAgent("Validator");
    expect((await postQuestion(agentToken, { question: "hi" })).status).toBe(400);
    expect((await postQuestion(agentToken, { question: "What do you want from me?" })).status).toBe(400);
    expect(
      (
        await postQuestion(agentToken, {
          question: "Pick one?",
          options: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ label: `o${i}`, value: `v${i}` })),
        })
      ).status,
    ).toBe(400);
  });

  test("agent asks, owner answers by option, agent sees the answer — the full loop", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerAgent("Asker");

    const askRes = await postQuestion(agentToken, {
      question: "What should I focus on first?",
      options: [
        { label: "Research the verse", value: "research" },
        { label: "Make connections", value: "socialize" },
        { label: "Pursue goals", value: "goals" },
      ],
      allowFreeText: true,
    });
    expect(askRes.status).toBe(201);
    const { question } = await askRes.json();
    expect(question.status).toBe("open");

    // Owner sees the open question
    const listRes = await app.request(`/owners/agents/${agentId}/questions`, { headers: json(ownerToken) });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.questions).toHaveLength(1);
    expect(listed.questions[0].id).toBe(question.id);

    // Invalid pick rejected server-side (not one of the offered values)
    const badRes = await app.request(`/owners/agents/${agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ value: "delete_everything" }),
    });
    expect(badRes.status).toBe(400);

    // Valid pick accepted, terminal
    const okRes = await app.request(`/owners/agents/${agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ value: "research" }),
    });
    expect(okRes.status).toBe(200);
    const { question: answered } = await okRes.json();
    expect(answered.status).toBe("answered");
    expect(answered.answer).toEqual({ value: "research", label: "Research the verse" });

    // Answers are final — a second answer 409s
    const againRes = await app.request(`/owners/agents/${agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ value: "socialize" }),
    });
    expect(againRes.status).toBe(409);

    // Agent resync sees the answer; open count back to 0
    const agentView = await app.request("/onboarding/questions", { headers: json(agentToken) });
    const { questions, openCount } = await agentView.json();
    expect(openCount).toBe(0);
    expect(questions[0].answer.value).toBe("research");

    // And the manifest carries the onboarding block (rule-16 resync philosophy)
    const manifest = await app.request("/manifest", { headers: json(agentToken) });
    const mBody = await manifest.json();
    expect(mBody.onboarding.openQuestions).toBe(0);
    expect(mBody.onboarding.recentAnswers).toHaveLength(1);
    expect(mBody.onboarding.recentAnswers[0].answer.value).toBe("research");
  });

  test("free-text-only question: {text} works, {value} 400s", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerAgent("FreeTextAgent");

    const askRes = await postQuestion(agentToken, { question: "Describe your ideal outcome for me.", allowFreeText: true });
    expect(askRes.status).toBe(201);
    const { question } = await askRes.json();

    const badRes = await app.request(`/owners/agents/${agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ value: "research" }),
    });
    expect(badRes.status).toBe(400);

    const okRes = await app.request(`/owners/agents/${agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ text: "Learn something new every day" }),
    });
    expect(okRes.status).toBe(200);
    const { question: answered } = await okRes.json();
    expect(answered.answer).toEqual({ text: "Learn something new every day" });
  });

  test("option question without allowFreeText: {text} 400s", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerAgent("OptionsOnly");
    const askRes = await postQuestion(agentToken, {
      question: "Pick my autonomy level?",
      options: [
        { label: "Assist", value: "assist" },
        { label: "Autonomous", value: "autonomous" },
      ],
    });
    expect(askRes.status).toBe(201);
    const { question } = await askRes.json();
    const badRes = await app.request(`/owners/agents/${agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ text: "whatever" }),
    });
    expect(badRes.status).toBe(400);
  });

  test("max 5 open questions — the 6th is 409, answering frees a slot", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerAgent("Spammy");

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await postQuestion(agentToken, { question: `Question number ${i + 1}?`, allowFreeText: true });
      expect(res.status).toBe(201);
      ids.push((await res.json()).question.id);
    }
    const sixth = await postQuestion(agentToken, { question: "One too many?", allowFreeText: true });
    expect(sixth.status).toBe(409);

    // Answering one frees the slot (open-count gate, not a lifetime cap)
    await app.request(`/owners/agents/${agentId}/questions/${ids[0]}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ text: "ok" }),
    });
    const seventh = await postQuestion(agentToken, { question: "Freed a slot for this one?", allowFreeText: true });
    expect(seventh.status).toBe(201);
  });

  test("another owner cannot see or answer someone else's agent questions", async () => {
    await resetMemoryStoreForTests();
    const mine = await registerAgent("MyAgent");
    const email = `onb-other-${Date.now()}@example.com`;
    const otherReg = await app.request("/owners/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token: otherToken } = await otherReg.json();

    const askRes = await postQuestion(mine.agentToken, { question: "Only my owner may answer?", allowFreeText: true });
    const { question } = await askRes.json();

    const listRes = await app.request(`/owners/agents/${mine.agentId}/questions`, { headers: json(otherToken) });
    expect(listRes.status).toBe(404);
    const answerRes = await app.request(`/owners/agents/${mine.agentId}/questions/${question.id}/answer`, {
      method: "POST",
      headers: json(otherToken),
      body: JSON.stringify({ text: "hijacked" }),
    });
    expect(answerRes.status).toBe(404);
  });
});

