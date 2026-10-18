import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../app";
import { websocket } from "./gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { db } from "../db/client";
import { agents, conversations, conversationParticipants } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { presenceKey } from "../presence";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

// PHASE1_SPEC WI-3 — presence v2: room-scoped digests, presence_summary
// above 1,000 active in a room, and the THREAD_PARTICIPANT_JOINED fanout
// diet. Scaffolding mirrors gateway.test.ts / subscription.test.ts.

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

beforeAll(async () => {
  await ensureRoomsSeeded();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function uniq(base: string): string {
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function registerAgent(name: string) {
  const email = `pv2-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();
  return { agentToken: agentToken as string, agentId: agent.id as string, name };
}

// Tickets are single-use: every WS connect mints a fresh one.
async function wsTicket(agentToken: string): Promise<string> {
  const res = await app.request("/auth/ws-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).ticket;
}

// Connects with a pre-minted ticket (test (b) pre-mints so its measured
// actions fit inside one digest window) and resolves once the server's
// agent_connected ack lands; every frame is collected into `frames`.
async function connectWithTicket(ticket: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
  const frames: any[] = [];
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for agent_connected")), 8000);
    ws.addEventListener("message", (msg) => {
      const event = JSON.parse(String(msg.data));
      frames.push(event);
      if (event.type === "agent_connected") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await connected;
  return { ws, frames };
}

async function connectAgent(agentToken: string): Promise<{ ws: WebSocket; frames: any[] }> {
  return connectWithTicket(await wsTicket(agentToken));
}

// Polls a collected-frames array until a frame matches (digest delivery
// is windowed, so frame waits are polls, not single onmessage promises).
async function waitForFrame(frames: any[], pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  return waitForFrameFrom(frames, 0, pred, timeoutMs);
}

// Same poll, but only frames at index >= fromIndex count — the array
// keeps growing while polling, so the scan must re-read its length each
// pass (a slice() taken up front would freeze the search space).
async function waitForFrameFrom(frames: any[], fromIndex: number, pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = fromIndex; i < frames.length; i++) {
      if (pred(frames[i])) return frames[i];
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for frame");
    await sleep(25);
  }
}

describe("presence v2 (WI-3)", () => {
  test("(a) digest entries reach room co-members only — an agent sharing no room perceives nothing", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent(uniq("Pv2Subject"));
    const b = await registerAgent(uniq("Pv2Outsider"));
    const c = await registerAgent(uniq("Pv2Peer"));

    // A and C share a conversation; B is in none. Created before any
    // socket connects, so both room sets populate at the live transition.
    const convRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.agentToken}` },
      body: JSON.stringify({ participantIds: [c.agentId] }),
    });
    expect(convRes.status).toBe(201);

    const bConn = await connectAgent(b.agentToken);
    const cConn = await connectAgent(c.agentToken);
    // Let B's and C's own join entries flush in their own window — the
    // assertions below measure only A's transitions.
    await sleep(1400);
    const bMark = bConn.frames.length;

    const aConn = await connectAgent(a.agentToken);
    const digest = await waitForFrame(
      cConn.frames,
      (e) => e.type === "presence_digest" && (e.payload.joined ?? []).some((j: any) => j.agent_id === a.agentId),
    );
    const entry = digest.payload.joined.find((j: any) => j.agent_id === a.agentId);
    // Wire shape unchanged for sub-threshold traffic: the internal room
    // attribution never reaches the socket, and no summaries appear.
    expect(entry).toEqual({ agent_id: a.agentId, name: a.name, capabilities: [] });
    expect(digest.payload.summaries).toBeUndefined();

    // B shares no room with A (or C): a full window passes and no digest
    // is delivered to B at all — scoping drops every entry for it.
    await sleep(1400);
    expect(bConn.frames.slice(bMark).filter((e) => e.type === "presence_digest")).toEqual([]);

    // A leaves: C perceives the departure, B still perceives nothing.
    aConn.ws.close();
    const leftDigest = await waitForFrame(
      cConn.frames,
      (e) => e.type === "presence_digest" && (e.payload.left ?? []).some((l: any) => l.agent_id === a.agentId),
    );
    expect(leftDigest.payload.left).toContainEqual({ agent_id: a.agentId });
    await sleep(1400);
    expect(bConn.frames.slice(bMark).filter((e) => e.type === "presence_digest")).toEqual([]);

    bConn.ws.close();
    cConn.ws.close();
  }, 30000);

  test("(b) a room above 1,000 active collapses to a presence_summary; a small room in the same flush still enumerates", async () => {
    await resetMemoryStoreForTests();
    const m = await registerAgent(uniq("Pv2Member"));
    const s1 = await registerAgent(uniq("Pv2Joiner"));
    const s2 = await registerAgent(uniq("Pv2Leaver"));
    const s3 = await registerAgent(uniq("Pv2SmallPeer"));

    // Seed the oversize room directly: 1,003 participant rows (M, S1, S2
    // + 1,000 fillers) — the spec's sanctioned light seam. "Connected"
    // state for fillers is the production presence truth: Redis TTL
    // keys, set through presence.ts. The summary computation and the
    // entry suppression under test are the production flush/delivery
    // code paths, exercised end to end over real sockets.
    const [bigRoom] = await db
      .insert(conversations)
      .values({ kind: "room", name: uniq("Pv2BigRoom"), isPublic: true })
      .returning();
    const [smallRoom] = await db
      .insert(conversations)
      .values({ kind: "group", name: uniq("Pv2SmallRoom"), isPublic: false })
      .returning();

    const fillerIds: string[] = [];
    const fillerRows = Array.from({ length: 1000 }, (_, i) => ({
      name: `${uniq("Pv2Filler")}-${i}`,
      agentCard: {},
      apiKeyHash: "x",
    }));
    // Chunked inserts keep each statement modest; ids collected per chunk.
    for (let i = 0; i < fillerRows.length; i += 250) {
      const inserted = await db.insert(agents).values(fillerRows.slice(i, i + 250)).returning({ id: agents.id });
      fillerIds.push(...inserted.map((r) => r.id));
    }
    // One statement for the big room's participants (a shared joinedAt
    // keeps every subject's connect backlog empty), one for the small room.
    await db.insert(conversationParticipants).values([
      { conversationId: bigRoom.id, agentId: m.agentId },
      { conversationId: bigRoom.id, agentId: s1.agentId },
      { conversationId: bigRoom.id, agentId: s2.agentId },
      ...fillerIds.map((id) => ({ conversationId: bigRoom.id, agentId: id })),
    ]);
    await db.insert(conversationParticipants).values([
      { conversationId: smallRoom.id, agentId: m.agentId },
      { conversationId: smallRoom.id, agentId: s3.agentId },
    ]);
    // Fillers are "connected" via the production presence keys.
    const pipe = redis.pipeline();
    for (const id of fillerIds) pipe.set(presenceKey(id), "1", "EX", 300);
    await pipe.exec();

    try {
      // S2 connects first and its join flushes in its own window (to
      // nobody — no other member is live yet).
      const s2Conn = await connectAgent(s2.agentToken);
      await sleep(1400);

      // M connects: its own join collects with rooms {big, small}. The
      // flush delivers M a digest carrying ONLY the big room's summary
      // (M's own entry is self-stripped; the entry is attributable to
      // the oversize room, so it collapses to counts). That frame is
      // the window-phase marker: a flush just happened, so the three
      // measured actions below land inside the fresh window.
      // Active at this flush: 1,000 fillers + S2 + M = 1,002.
      const mConn = await connectAgent(m.agentToken);
      const marker = await waitForFrame(
        mConn.frames,
        (e) => e.type === "presence_digest" && (e.payload.summaries ?? []).some((s: any) => s.room_conversation_id === bigRoom.id),
      );
      expect(marker.payload.joined).toEqual([]);
      expect(marker.payload.left).toEqual([]);
      expect(marker.payload.summaries).toEqual([
        { room_conversation_id: bigRoom.id, joined_count: 1, left_count: 0, active_count: 1002 },
      ]);
      const mMark = mConn.frames.length;

      // Mint the measured-window tickets only now: agentAuth touches
      // the API presence key on every authenticated call, so minting
      // S1's ticket earlier would have inflated the marker's
      // active_count by one (S1 "online" before ever connecting).
      const s1Ticket = await wsTicket(s1.agentToken);
      const s3Ticket = await wsTicket(s3.agentToken);

      // Measured window: S1 joins (big room only), S3 joins (small room
      // only), S2 leaves (big room only) — concurrently, inside the
      // window the marker just opened.
      const [s1Conn, s3Conn] = await Promise.all([connectWithTicket(s1Ticket), connectWithTicket(s3Ticket)]);
      s2Conn.ws.close();

      const flush = await waitForFrameFrom(
        mConn.frames,
        mMark,
        (e) =>
          e.type === "presence_digest" &&
          (e.payload.summaries ?? []).some((s: any) => s.room_conversation_id === bigRoom.id) &&
          (e.payload.joined ?? []).some((j: any) => j.agent_id === s3.agentId),
        10000,
      );
      // The oversize room reports counts only: S1's join and S2's leave
      // are inside joined_count/left_count, never enumerated. (S2's
      // presence key was cleared by its close, so active is 1,002
      // again: 1,000 fillers + M + S1.)
      expect(flush.payload.summaries).toEqual([
        { room_conversation_id: bigRoom.id, joined_count: 1, left_count: 1, active_count: 1002 },
      ]);
      // The small room in the same flush still enumerates, wire shape
      // unchanged (no room attribution leaks).
      expect(flush.payload.joined).toEqual([{ agent_id: s3.agentId, name: s3.name, capabilities: [] }]);
      expect(flush.payload.left).toEqual([]);
      // And across every digest M received in the measured window, the
      // oversize room's subjects were never enumerated.
      const measured = mConn.frames.slice(mMark).filter((e) => e.type === "presence_digest");
      for (const frame of measured) {
        const ids = [...(frame.payload.joined ?? []), ...(frame.payload.left ?? [])].map((x: any) => x.agent_id);
        expect(ids).not.toContain(s1.agentId);
        expect(ids).not.toContain(s2.agentId);
      }

      s1Conn.ws.close();
      s3Conn.ws.close();
      mConn.ws.close();
    } finally {
      // Restore global state: filler presence keys outlive the test
      // otherwise (300 s TTL), and 1,000 agent rows would linger in
      // every later suite's roster scans.
      const del = redis.pipeline();
      for (const id of fillerIds) del.del(presenceKey(id));
      await del.exec();
      await db.delete(conversationParticipants).where(eq(conversationParticipants.conversationId, bigRoom.id));
      await db.delete(conversationParticipants).where(eq(conversationParticipants.conversationId, smallRoom.id));
      await db.delete(conversations).where(inArray(conversations.id, [bigRoom.id, smallRoom.id]));
      for (let i = 0; i < fillerIds.length; i += 250) {
        await db.delete(agents).where(inArray(agents.id, fillerIds.slice(i, i + 250)));
      }
    }
  }, 60000);

  test("(c) THREAD_PARTICIPANT_JOINED is published once as a room-scoped broadcast, delivered only to members, replayed from backlog", async () => {
    await resetMemoryStoreForTests();
    const memberLive = await registerAgent(uniq("Pv2RoomLive"));
    const memberOffline = await registerAgent(uniq("Pv2RoomOffline"));
    const outsider = await registerAgent(uniq("Pv2RoomOutsider"));
    const joiner = await registerAgent(uniq("Pv2RoomJoiner"));

    const joinRoom = async (token: string) => {
      const res = await app.request("/rooms/general/join", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as any).conversationId as string;
    };

    // Both members join before the joiner; the offline member never
    // connects until the backlog assertion at the end.
    const conversationId = await joinRoom(memberOffline.agentToken);
    expect(await joinRoom(memberLive.agentToken)).toBe(conversationId);

    const liveConn = await connectAgent(memberLive.agentToken);
    const outsiderConn = await connectAgent(outsider.agentToken);
    await sleep(300);

    // Count fanout publishes on the real channel: the join must cost
    // exactly ONE publish (the old per-participant loop cost one per
    // existing participant — two members here, plus would grow with
    // the room).
    const fanoutSub = redis.duplicate();
    const fanoutRaw: string[] = [];
    fanoutSub.on("message", (_channel: string, raw: string) => fanoutRaw.push(raw));
    await fanoutSub.subscribe("ws:fanout");
    await sleep(200);

    try {
      expect(await joinRoom(joiner.agentToken)).toBe(conversationId);
      await sleep(800);

      const joinedPublishes = fanoutRaw
        .map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })
        .filter(
          (msg) =>
            msg &&
            msg.event?.type === "thread_participant_joined" &&
            msg.event?.payload?.conversation_id === conversationId &&
            msg.event?.payload?.agent_id === joiner.agentId,
        );
      expect(joinedPublishes).toHaveLength(1);
      expect(joinedPublishes[0].kind).toBe("broadcast");
      expect(joinedPublishes[0].roomConversationId).toBe(conversationId);
      // The room-join exception is preserved: the joiner is not
      // notified of their own join.
      expect(joinedPublishes[0].exceptAgentId).toBe(joiner.agentId);

      // Delivered live to a connected member…
      const delivered = await waitForFrame(
        liveConn.frames,
        (e) => e.type === "thread_participant_joined" && e.payload.agent_id === joiner.agentId,
      );
      expect(delivered.payload.conversation_id).toBe(conversationId);
      // …and never to a connected non-member (room-scope filter).
      await sleep(1200);
      expect(
        outsiderConn.frames.some(
          (e) => e.type === "thread_participant_joined" && e.payload.conversation_id === conversationId,
        ),
      ).toBe(false);

      // The offline member still learns of the join — from the backlog
      // on connect, the correctness path the filtered live frame is
      // allowed to rely on.
      const offlineConn = await connectAgent(memberOffline.agentToken);
      const replayed = await waitForFrame(
        offlineConn.frames,
        (e) => e.type === "thread_participant_joined" && e.payload.agent_id === joiner.agentId,
      );
      expect(replayed.payload.conversation_id).toBe(conversationId);
      offlineConn.ws.close();
    } finally {
      await fanoutSub.quit().catch(() => {});
      liveConn.ws.close();
      outsiderConn.ws.close();
    }
  }, 30000);
});
