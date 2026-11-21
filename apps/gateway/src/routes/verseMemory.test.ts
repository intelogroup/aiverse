// Carry-back: an agent writes and recalls notes, the server writes its own ledger, the owner reads both and nobody else can.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { verseMemory } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { clearAuthCaches } from "../auth/authCache";
import { MAX_NOTES, MAX_PINNED, recordLedger } from "../world/verseMemory";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
beforeEach(async () => { clearAuthCaches(); await resetMemoryStoreForTests(); });

const json = (t?: string) => ({ "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) });
const uniq = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

async function ownerWithAgent(label = "Mem") {
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email: `mem-${uniq()}@example.com`, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token: ownerToken, owner } = (await reg.json()) as any;
  const ag = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `${label}${uniq()}` }) });
  expect(ag.status).toBe(201);
  const body = (await ag.json()) as any;
  return { ownerToken: ownerToken as string, ownerId: owner.id as string, agentId: body.agent.id as string, agentToken: body.agentToken as string };
}
const remember = (token: string, body: unknown) => app.request("/verse/memory", { method: "POST", headers: json(token), body: JSON.stringify(body) });
const recallReq = (token: string, qs = "") => app.request(`/verse/memory${qs}`, { headers: json(token) });
const ownerRead = (o: { ownerToken: string; agentId: string }, qs = "") => app.request(`/owners/agents/${o.agentId}/memory${qs}`, { headers: json(o.ownerToken) });

describe("an agent writes notes and its owner reads them", () => {
  test("a note round-trips with its place, point and subject, and the owner sees it as a note", async () => {
    const o = await ownerWithAgent();
    const res = await remember(o.agentToken, { text: "red key behind the fountain", kind: "find", place: "plaza-fountain", point: [12.4, 40], subject: "prop-key-7" });
    expect(res.status).toBe(201);
    const read = (await (await ownerRead(o)).json()) as any;
    const note = read.memory.find((m: any) => m.tier === "note");
    expect(note).toMatchObject({ kind: "find", text: "red key behind the fountain", placeId: "plaza-fountain", pointX: 12.4, pointZ: 40, subject: "prop-key-7", pinned: false });
    expect(read.unseen).toBeGreaterThanOrEqual(1);
  });

  test("bad notes are refused with the rule named: link, line break, too long, empty, unknown kind, stray field, bad point", async () => {
    const o = await ownerWithAgent();
    const cases: [unknown, RegExp][] = [
      [{ text: "see http://evil.example/x" }, /links/],
      [{ text: "see www.evil.example" }, /links/],
      [{ text: "two\nlines" }, /line/],
      [{ text: "x".repeat(501) }, /1-500/],
      [{ text: "   " }, /1-500/],
      [{ text: "ok", kind: "secret" }, /kind must be/],
      [{ text: "ok", extra: 1 }, /unexpected field/],
      [{ text: "ok", point: [1, 99999] }, /point must be/],
      [{ text: "ok", pin: "yes" }, /pin must be/],
      ["just a string", /body must be an object/],
    ];
    for (const [body, rule] of cases) {
      const res = await remember(o.agentToken, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(rule);
    }
    expect((await remember(undefined as any, { text: "x" })).status).toBe(401);
    const read = (await (await ownerRead(o)).json()) as any;
    expect(read.memory.filter((m: any) => m.tier === "note")).toHaveLength(0);
  });

  test("ordinary dotted text is not mistaken for a link", async () => {
    const o = await ownerWithAgent();
    expect((await remember(o.agentToken, { text: "Met Dr. Rivera at 3.5 km, shop no. 4." })).status).toBe(201);
  });

  test("only the owner of the agent can read it: another owner and no token get nothing", async () => {
    const mine = await ownerWithAgent("Mine");
    const other = await ownerWithAgent("Other");
    await remember(mine.agentToken, { text: "private find" });
    const foreign = await app.request(`/owners/agents/${mine.agentId}/memory`, { headers: json(other.ownerToken) });
    expect(foreign.status).toBe(404);
    expect((await app.request(`/owners/agents/${mine.agentId}/memory.md`, { headers: json(other.ownerToken) })).status).toBe(404);
    expect((await app.request(`/owners/agents/${mine.agentId}/memory`)).status).toBe(401);
    expect((await app.request(`/owners/agents/${mine.agentId}/memory`, { headers: json(mine.agentToken) })).status).toBe(401);
  });

  test("an agent recalls only its own memory", async () => {
    const a = await ownerWithAgent("A"), b = await ownerWithAgent("B");
    await remember(a.agentToken, { text: "A's secret", place: "shop-1" });
    const seenByB = (await (await recallReq(b.agentToken, "?place=shop-1")).json()) as any;
    expect([...seenByB.here, ...seenByB.pinned, ...seenByB.recent].map((r: any) => r.text)).not.toContain("A's secret");
  });
});

describe("recall", () => {
  test("rows at the place come first, then pinned, then the latest, with no row listed twice", async () => {
    const o = await ownerWithAgent();
    await remember(o.agentToken, { text: "pinned at cafe", place: "cafe", pin: true });
    await remember(o.agentToken, { text: "pinned elsewhere", place: "park", pin: true });
    await remember(o.agentToken, { text: "plain at cafe", place: "cafe" });
    await remember(o.agentToken, { text: "latest at park", place: "park" });
    const r = (await (await recallReq(o.agentToken, "?place=cafe")).json()) as any;
    expect(r.here.map((x: any) => x.text).sort()).toEqual(["pinned at cafe", "plain at cafe"]);
    expect(r.pinned.map((x: any) => x.text)).toEqual(["pinned elsewhere"]);
    const all = [...r.here, ...r.pinned, ...r.recent].map((x: any) => x.id);
    expect(new Set(all).size).toBe(all.length);
    expect(r.recent.map((x: any) => x.text)).toContain("latest at park");
  });

  test("kind and limit narrow it; a nonsense limit does not crash", async () => {
    const o = await ownerWithAgent();
    for (let i = 0; i < 5; i++) await remember(o.agentToken, { text: `lesson ${i}`, kind: "lesson" });
    await remember(o.agentToken, { text: "a person", kind: "person" });
    const r = (await (await recallReq(o.agentToken, "?kind=lesson&limit=2")).json()) as any;
    expect(r.recent).toHaveLength(2);
    expect(r.recent.every((x: any) => x.kind === "lesson")).toBe(true);
    expect((await recallReq(o.agentToken, "?limit=abc")).status).toBe(200);
  });
});

describe("caps", () => {
  test("the note past the cap drops the oldest unpinned one and keeps the pinned", async () => {
    const o = await ownerWithAgent();
    const pinned = await (await remember(o.agentToken, { text: "keep me", pin: true })).json() as any;
    await db.insert(verseMemory).values(Array.from({ length: MAX_NOTES - 1 }, (_, i) => ({
      agentId: o.agentId, ownerId: o.ownerId, tier: "note", kind: "note", text: `old ${i}`, createdAt: new Date(Date.now() - 1_000_000 + i),
    })));
    expect((await remember(o.agentToken, { text: "newest" })).status).toBe(201);
    const rows = await db.select().from(verseMemory).where(eq(verseMemory.agentId, o.agentId));
    const notes = rows.filter((r) => r.tier === "note");
    expect(notes).toHaveLength(MAX_NOTES);
    expect(notes.map((r) => r.text)).toContain("keep me");
    expect(notes.map((r) => r.text)).toContain("newest");
    expect(notes.map((r) => r.text)).not.toContain("old 0");
    expect(pinned.note.pinned).toBe(true);
  });

  test("pinning past the pin budget is refused with 409 and the unpinned write still works", async () => {
    const o = await ownerWithAgent();
    await db.insert(verseMemory).values(Array.from({ length: MAX_PINNED }, (_, i) => ({
      agentId: o.agentId, ownerId: o.ownerId, tier: "note", kind: "note", text: `pin ${i}`, pinned: true,
    })));
    const res = await remember(o.agentToken, { text: "one too many", pin: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/pin limit/);
    expect((await remember(o.agentToken, { text: "unpinned is fine" })).status).toBe(201);
  });

  test("a burst of notes is rate limited with 429", async () => {
    const o = await ownerWithAgent();
    const codes: number[] = [];
    for (let i = 0; i < 24; i++) codes.push((await remember(o.agentToken, { text: `n${i}` })).status);
    expect(codes.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(codes.slice(20)).toContain(429);
  });

  test("simultaneous writes at the cap leave exactly the cap", async () => {
    const o = await ownerWithAgent();
    await db.insert(verseMemory).values(Array.from({ length: MAX_NOTES }, (_, i) => ({
      agentId: o.agentId, ownerId: o.ownerId, tier: "note", kind: "note", text: `old ${i}`, createdAt: new Date(Date.now() - 1_000_000 + i),
    })));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => remember(o.agentToken, { text: `race ${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const notes = (await db.select().from(verseMemory).where(eq(verseMemory.agentId, o.agentId))).filter((r) => r.tier === "note");
    expect(notes).toHaveLength(MAX_NOTES);
  });
});

describe("the ledger and the owner's views", () => {
  const start = (o: { ownerToken: string; agentId: string }) =>
    app.request(`/owners/agents/${o.agentId}/visits`, { method: "POST", headers: json(o.ownerToken), body: JSON.stringify({ minutes: 30, maxActions: 100 }) });

  test("starting and stopping a visit leaves two ledger rows the owner reads as the server's record", async () => {
    const o = await ownerWithAgent();
    const started = await start(o);
    expect(started.status).toBe(201);
    const { visit } = (await started.json()) as any;
    expect((await app.request(`/owners/agents/${o.agentId}/visits/${visit.id}/stop`, { method: "POST", headers: json(o.ownerToken) })).status).toBe(200);
    const read = (await (await ownerRead(o, "?tier=ledger")).json()) as any;
    const texts = read.memory.map((m: any) => m.text);
    expect(texts.some((t: string) => /Visit started: 30 minutes/.test(t))).toBe(true);
    expect(texts.some((t: string) => /Visit ended: owner stopped/.test(t))).toBe(true);
    expect(read.memory.every((m: any) => m.tier === "ledger" && m.visitId === visit.id)).toBe(true);
  });

  test("a note written during a visit is tagged with that visit", async () => {
    const o = await ownerWithAgent();
    const { visit } = (await (await start(o)).json()) as any;
    expect((await remember(o.agentToken, { text: "in the visit" })).status).toBe(201);
    const read = (await (await ownerRead(o, "?tier=note")).json()) as any;
    expect(read.memory[0].visitId).toBe(visit.id);
  });

  test("a ledger write that fails never throws into the caller", async () => {
    const o = await ownerWithAgent();
    // An agent id that does not exist breaks the foreign key: the call must still resolve.
    await expect(recordLedger("00000000-0000-4000-8000-000000000000", o.ownerId, { kind: "visit", text: "orphan" })).resolves.toBeUndefined();
  });

  test("markdown export labels the server's record as fact and the agent's notes as its own word; seen clears the count", async () => {
    const o = await ownerWithAgent("Scout");
    await start(o);
    await remember(o.agentToken, { text: "fountain is dry", kind: "place", place: "plaza", point: [3, 4] });
    const md = await app.request(`/owners/agents/${o.agentId}/memory.md`, { headers: json(o.ownerToken) });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const text = await md.text();
    expect(text).toMatch(/## What the Verse recorded \(seen by the server\)\n- .*Visit started/);
    expect(text).toMatch(/## What the agent says it noticed \(its own words, not verified\)\n- .*\[place · plaza @3,4\] fountain is dry/);
    const before = (await (await ownerRead(o)).json()) as any;
    expect(before.unseen).toBe(2);
    const marked = (await (await app.request(`/owners/agents/${o.agentId}/memory/seen`, { method: "POST", headers: json(o.ownerToken) })).json()) as any;
    expect(marked.marked).toBe(2);
    expect(((await (await ownerRead(o)).json()) as any).unseen).toBe(0);
  });

  test("deleting the agent deletes its memory", async () => {
    const o = await ownerWithAgent();
    await remember(o.agentToken, { text: "gone soon" });
    const del = await app.request(`/owners/agents/${o.agentId}`, { method: "DELETE", headers: json(o.ownerToken) });
    expect([200, 204]).toContain(del.status);
    expect(await db.select().from(verseMemory).where(eq(verseMemory.agentId, o.agentId))).toHaveLength(0);
  });
});
