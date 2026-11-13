import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Agent, ConsoleEvent, PublicActivityItem } from "./api";
import { queryKeys } from "./queryClient";

// Phase 1 state-migration mechanics: identical shell reads share one
// cache entry (one request), per-limit activity reads stay separate,
// and the WS patch helpers apply exactly the updates App.tsx used to
// hand-roll over useState arrays.
const apiMock = vi.hoisted(() => ({
  publicActivity: vi.fn(),
  publicConversation: vi.fn(),
  listAgents: vi.fn(),
  discoverRoster: vi.fn(),
  listRooms: vi.fn(),
  roomPresence: vi.fn(),
  trending: vi.fn(),
  me: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import {
  patchAgentStatus,
  prependLiveEvent,
  usePublicActivityQuery,
  usePublicConversationQuery,
} from "./queries";

afterEach(() => cleanup());

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const activityItem: PublicActivityItem = {
  conversation_id: "conv-1",
  last_message: "hello verse",
  last_sender_agent_id: "agent-1",
  last_message_at: "2026-11-12T00:00:00Z",
  agent_count: 2,
  message_count: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.publicActivity.mockResolvedValue({ activity: [activityItem] });
  apiMock.publicConversation.mockResolvedValue({ messages: [] });
});

describe("usePublicActivityQuery", () => {
  it("dedupes identical reads across consumers into one request", async () => {
    const qc = makeClient();
    const wrapper = wrapperFor(qc);
    const a = renderHook(() => usePublicActivityQuery(30), { wrapper });
    const b = renderHook(() => usePublicActivityQuery(30), { wrapper });

    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));
    expect(apiMock.publicActivity).toHaveBeenCalledTimes(1);
    expect(a.result.current.data).toEqual([activityItem]);
    expect(b.result.current.data).toEqual([activityItem]);
  });

  it("keeps the feed's limit=50 read in its own cache entry", async () => {
    const qc = makeClient();
    const wrapper = wrapperFor(qc);
    const shell = renderHook(() => usePublicActivityQuery(30), { wrapper });
    const feed = renderHook(() => usePublicActivityQuery(50), { wrapper });

    await waitFor(() => expect(shell.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(feed.result.current.isSuccess).toBe(true));
    expect(apiMock.publicActivity).toHaveBeenCalledTimes(2);
    // The default-limit read keeps the pre-Query URL (no param); only the
    // feed's explicit 50 is passed through.
    expect(apiMock.publicActivity).toHaveBeenCalledWith(undefined);
    expect(apiMock.publicActivity).toHaveBeenCalledWith(50);
  });

  it("refetches when the shared key is invalidated (the WS-poke path)", async () => {
    const qc = makeClient();
    const hook = renderHook(() => usePublicActivityQuery(30), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(apiMock.publicActivity).toHaveBeenCalledTimes(1);

    await qc.invalidateQueries({ queryKey: queryKeys.publicActivity(30) });
    await waitFor(() => expect(apiMock.publicActivity).toHaveBeenCalledTimes(2));
  });
});

describe("usePublicConversationQuery", () => {
  it("keeps the previous thread's messages visible while the next loads", async () => {
    const msgA = { id: "m1", content: "from A", senderAgentId: "agent-1", createdAt: "2026-11-12T00:00:00Z" };
    const msgB = { id: "m2", content: "from B", senderAgentId: "agent-2", createdAt: "2026-11-12T00:01:00Z" };
    let resolveB: (v: { messages: typeof msgB[] }) => void = () => {};
    apiMock.publicConversation.mockImplementation((id: string) =>
      id === "a" ? Promise.resolve({ messages: [msgA] }) : new Promise((res) => (resolveB = res)),
    );
    const qc = makeClient();
    const hook = renderHook(({ id }: { id: string | null }) => usePublicConversationQuery(id), {
      wrapper: wrapperFor(qc),
      initialProps: { id: "a" as string | null },
    });
    await waitFor(() => expect(hook.result.current.data).toEqual([msgA]));

    hook.rerender({ id: "b" });
    // Thread B is still loading; A's messages stay on screen (the old
    // setState-only-on-success behaviour), flagged as placeholder data.
    expect(hook.result.current.data).toEqual([msgA]);
    expect(hook.result.current.isPlaceholderData).toBe(true);

    resolveB({ messages: [msgB] });
    await waitFor(() => expect(hook.result.current.data).toEqual([msgB]));
  });
});

describe("usePublicConversationQuery delta", () => {
  it("refetches only from the newest cached message and merges by id", async () => {
    const m = (n: number) => ({ id: `m${n}`, content: `c${n}`, senderAgentId: "a", createdAt: `2026-11-12T00:0${n}:00Z` });
    apiMock.publicConversation.mockImplementation((_id: string, after?: string) =>
      Promise.resolve({ messages: after ? [m(2), m(3)] : [m(1), m(2)] }),
    );
    const qc = makeClient();
    const hook = renderHook(() => usePublicConversationQuery("a"), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(hook.result.current.data).toEqual([m(1), m(2)]));
    expect(apiMock.publicConversation).toHaveBeenLastCalledWith("a");

    await hook.result.current.refetch();
    // inclusive cursor re-sent m2: asked from m2's time, no duplicate in the merged list
    expect(apiMock.publicConversation).toHaveBeenLastCalledWith("a", m(2).createdAt);
    await waitFor(() => expect(hook.result.current.data).toEqual([m(1), m(2), m(3)]));
  });
});

describe("WS patch helpers", () => {
  const agent = (id: string, status: Agent["status"]): Agent => ({
    id,
    name: id,
    agentCard: { capabilities: [] },
    status,
  });

  it("patchAgentStatus patches only the named agent in the cached list", () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.agents, { agents: [agent("a1", "offline"), agent("a2", "offline")] });
    patchAgentStatus(qc, { agent_id: "a2", status: "online" });
    const after = qc.getQueryData<{ agents: Agent[] }>(queryKeys.agents);
    expect(after?.agents.map((a) => [a.id, a.status])).toEqual([
      ["a1", "offline"],
      ["a2", "online"],
    ]);
  });

  it("patchAgentStatus is a no-op before the list has loaded", () => {
    const qc = makeClient();
    patchAgentStatus(qc, { agent_id: "a2", status: "online" });
    expect(qc.getQueryData(queryKeys.agents)).toBeUndefined();
  });

  it("prependLiveEvent prepends and caps the list at 200", () => {
    const qc = makeClient();
    const ev = (id: string): ConsoleEvent => ({
      id,
      agentId: "a1",
      ownerId: "o1",
      severity: "activity",
      summary: id,
      refConversationId: null,
      createdAt: "2026-11-12T00:00:00Z",
      resolvedAt: null,
    });
    qc.setQueryData<ConsoleEvent[]>(
      queryKeys.liveEvents,
      Array.from({ length: 200 }, (_, i) => ev(`old-${i}`)),
    );
    prependLiveEvent(qc, ev("new"));
    const after = qc.getQueryData<ConsoleEvent[]>(queryKeys.liveEvents);
    expect(after).toHaveLength(200);
    expect(after?.[0].id).toBe("new");
    expect(after?.[199].id).toBe("old-198");
  });
});
