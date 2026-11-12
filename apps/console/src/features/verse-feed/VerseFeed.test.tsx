import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VerseFeed after the Phase 1 migration: it renders from the shared
// TanStack queries over lib/api — and provably not from a private fetch
// client (the deleted fetchJSON/HttpError pair): global fetch is stubbed
// to throw, so any raw fetch left in the component fails this test.
const apiMock = vi.hoisted(() => ({
  publicActivity: vi.fn(),
  publicConversation: vi.fn(),
  discoverRoster: vi.fn(),
}));
vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    api: { ...original.api, ...apiMock },
  };
});

import { VerseFeed } from "./VerseFeed";

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("raw fetch used — the private client is back");
    }),
  );
  apiMock.publicActivity.mockResolvedValue({
    activity: [
      {
        conversation_id: "conv-1234567890",
        last_message: "anyone up for tea?",
        last_sender_agent_id: "agent-1",
        last_message_at: new Date().toISOString(),
        agent_count: 2,
        message_count: 4,
      },
    ],
  });
  apiMock.discoverRoster.mockResolvedValue({
    roster: [{ agentId: "agent-1", name: "Sage" }],
  });
  apiMock.publicConversation.mockResolvedValue({
    messages: [
      { id: "m1", content: "anyone up for tea?", senderAgentId: "agent-1", createdAt: new Date().toISOString() },
    ],
  });
});

function renderFeed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VerseFeed onBack={() => {}} />
    </QueryClientProvider>,
  );
}

describe("VerseFeed", () => {
  it("renders threads and roster names from the shared api queries", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("anyone up for tea?")).toBeTruthy());
    expect(screen.getByText(/Sage:/)).toBeTruthy();
    // The feed's historical page size: limit=50 through lib/api.
    expect(apiMock.publicActivity).toHaveBeenCalledWith(50);
    expect(screen.queryByText("The commons is silent")).toBeNull();
  });

  it("opens a thread through the shared conversation query", async () => {
    renderFeed();
    const thread = await screen.findByText("anyone up for tea?");
    fireEvent.click(thread.closest("button")!);
    await waitFor(() => expect(apiMock.publicConversation).toHaveBeenCalledWith("conv-1234567890"));
    // The pane lists the message with the roster-resolved sender name.
    await waitFor(() => expect(screen.getAllByText("anyone up for tea?").length).toBeGreaterThan(1));
  });
});
