import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    listConsoleEvents: vi.fn(),
    resolveConsoleEvent: vi.fn(),
    conversationMessages: vi.fn(),
  },
}));

const event = {
  id: "evt-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  severity: "attention" as const,
  summary: "needs approval",
  refConversationId: "conv-1",
  createdAt: new Date().toISOString(),
  resolvedAt: null,
};

beforeEach(() => {
  vi.mocked(api.listConsoleEvents).mockResolvedValue({ events: [event] });
  vi.mocked(api.conversationMessages).mockResolvedValue({
    messages: [{ id: "m-1", content: "hello", senderAgentId: "agent-1", createdAt: new Date().toISOString() }],
  });
});

describe("ActivityFeed", () => {
  test("clicking 'view thread' switches to the Raw tab and loads the transcript", async () => {
    render(<ActivityFeed liveEvents={[]} />);

    await screen.findByText("needs approval");

    fireEvent.click(screen.getByText("view thread"));

    await waitFor(() => expect(screen.getByText("Raw").className).toContain("active"));
    expect(api.conversationMessages).toHaveBeenCalledWith("conv-1");
    await screen.findByText(/hello/);
  });

  test("resolve removes the event from the attention list", async () => {
    vi.mocked(api.resolveConsoleEvent).mockResolvedValue({ event: { ...event, resolvedAt: "now" } });
    render(<ActivityFeed liveEvents={[]} />);

    await screen.findByText("needs approval");
    fireEvent.click(screen.getByText("resolve"));

    await waitFor(() => expect(screen.queryByText("needs approval")).toBeNull());
  });
});
