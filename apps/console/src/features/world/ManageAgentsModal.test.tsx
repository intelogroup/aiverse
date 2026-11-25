import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Visit, Wallet } from "../../lib/api";

// The modal is the owner's lifecycle surface: autonomy + visits. These
// tests pin that the controls render from the gateway's rows and that
// each control issues the right client call — the regression class this
// UI exists to close is "the console promised controls that weren't
// wired to anything."
const apiMock = vi.hoisted(() => ({
  getWallet: vi.fn(),
  patchWallet: vi.fn(),
  listVisits: vi.fn(),
  listVerseInventory: vi.fn(),
  listHuntReceipts: vi.fn(),
  startVisit: vi.fn(),
  stopVisit: vi.fn(),
  rotateAgentToken: vi.fn(),
  setAgentBody: vi.fn(),
}));
vi.mock("../../lib/api", () => ({
  api: apiMock,
  describeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));
vi.mock("../../lib/toast", () => ({ pushToast: vi.fn() }));

import { ManageAgentsModal } from "./ManageAgentsModal";

// vitest globals are off in this workspace, so RTL's auto-cleanup never
// hooks in — without this, renders accumulate across tests in the file.
afterEach(() => cleanup());

const agent = {
  id: "agent-1",
  name: "ProbeOne",
  agentCard: { capabilities: [] },
  status: "offline",
} as unknown as Agent;

const wallet: Wallet = {
  agentId: "agent-1",
  dailyTokenBudget: 0,
  maxTokensPerConversation: 0,
  maxSimultaneousConversations: 0,
  maxAgentCallsPerDay: 0,
  spendingAuthorityCents: 0,
  autonomyMode: "observe",
};

const activeVisit: Visit = {
  id: "visit-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  endsAt: new Date(Date.now() + 25 * 60_000).toISOString(),
  maxActions: 200,
  actionsUsed: 3,
  offlineSince: null,
  endedAt: null,
  endedReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getWallet.mockResolvedValue({ wallet });
  apiMock.patchWallet.mockImplementation(async (_id: string, patch: Partial<Wallet>) => ({
    wallet: { ...wallet, ...patch },
  }));
  apiMock.listVisits.mockResolvedValue({ visits: [] });
  apiMock.listHuntReceipts.mockResolvedValue({ receipts: [] });
  apiMock.startVisit.mockResolvedValue({ visit: activeVisit });
  apiMock.stopVisit.mockResolvedValue({ ok: true });
  apiMock.setAgentBody.mockImplementation(async (id: string, body: string | null) => ({ agent: { id, body } }));
});

describe("ManageAgentsModal lifecycle controls", () => {
  it("fetches inventory on demand and displays the item, credits, and receipt", async () => {
    apiMock.listVerseInventory.mockResolvedValue({
      items: [{ id: "item-1", name: "Ceramic token" }],
      progress: { credits: 3, xp: 5 },
      receipts: [{ id: "sale-1", itemName: "Ceramic token", price: 2, side: "bought" }],
    });
    render(<ManageAgentsModal agents={[agent]} onClose={() => {}} />);
    const section = screen.getByText("Verse inventory").closest("details")!;
    expect(apiMock.listVerseInventory).not.toHaveBeenCalled();
    section.open = true;
    fireEvent(section, new Event("toggle"));
    expect(await screen.findByText("Ceramic token")).toBeTruthy();
    expect(screen.getByText("3 credits · 5 XP")).toBeTruthy();
    expect(screen.getByText("Bought Ceramic token for 2 credits")).toBeTruthy();
    expect(apiMock.listVerseInventory).toHaveBeenCalledWith("agent-1", undefined);
  });

  it("renders the autonomy selector with the wallet's current mode and patches on change", async () => {
    render(<ManageAgentsModal agents={[agent]} onClose={() => {}} />);
    const select = (await screen.findByLabelText("ProbeOne autonomy")) as HTMLSelectElement;
    expect(select.value).toBe("observe");

    fireEvent.change(select, { target: { value: "autonomous" } });
    await waitFor(() => expect(apiMock.patchWallet).toHaveBeenCalledWith("agent-1", { autonomyMode: "autonomous" }));
  });

  it("with no active visit, Start visit issues the start call with the form values (defaults 30 / 200)", async () => {
    render(<ManageAgentsModal agents={[agent]} onClose={() => {}} />);
    const start = await screen.findByRole("button", { name: "Start visit" });
    fireEvent.click(start);
    await waitFor(() => expect(apiMock.startVisit).toHaveBeenCalledWith("agent-1", 30, 200));
  });

  it("with an active visit, shows the visit state and Stop visit issues the stop call", async () => {
    apiMock.listVisits.mockResolvedValue({ visits: [activeVisit] });
    render(<ManageAgentsModal agents={[agent]} onClose={() => {}} />);

    expect(await screen.findByText(/Visit active/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start visit" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop visit" }));
    await waitFor(() => expect(apiMock.stopVisit).toHaveBeenCalledWith("agent-1", "visit-1"));
  });

  it("shows a past bounty as plain text and copies it only on request", async () => {
    const payload = '<img src=x onerror=alert(1)> [download](https://example.com)';
    apiMock.listHuntReceipts.mockResolvedValue({
      receipts: [{
        contestId: "tea-hunt", payload, credits: 10, wonAt: "2026-11-19T12:00:00Z",
        cashPayout: { amountCents: 100, currency: "USD", mode: "live", status: "success", transactionId: "TEST-TX" },
      }],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(<ManageAgentsModal agents={[agent]} onClose={() => {}} />);
      expect(await screen.findByRole("button", { name: "Start visit" })).toBeTruthy();
      expect(apiMock.listHuntReceipts).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "View bounty receipts" }));
      expect((await screen.findByText(payload)).textContent).toEqual(payload);
      expect(screen.getByText(/PayPal payout .* Paid/)).toBeTruthy();
      expect(apiMock.listHuntReceipts).toHaveBeenCalledWith("agent-1");
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      expect(writeText).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Copy payload" }));
      expect(writeText).toHaveBeenCalledWith(payload);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("offers exactly the agent-eligible bodies, shows the saved one, and saves a change", async () => {
    render(<ManageAgentsModal agents={[{ ...agent, body: "cipher" }]} onClose={() => {}} />);
    const select = (await screen.findByLabelText("ProbeOne body")) as HTMLSelectElement;
    expect(select.value).toBe("cipher");
    const offered = Array.from(select.options).map((o) => o.value);
    expect(offered).toEqual(expect.arrayContaining(["remy", "cipher", "eve"]));
    for (const castOnly of ["cast", "mage", "skeleton-warrior", "knight", "barbarian", "summer"]) expect(offered).not.toContain(castOnly);

    fireEvent.change(select, { target: { value: "eve" } });
    await waitFor(() => expect(apiMock.setAgentBody).toHaveBeenCalledWith("agent-1", "eve"));
  });

  it("an agent with no saved body shows the platform default (remy)", async () => {
    render(<ManageAgentsModal agents={[agent]} onClose={() => {}} />);
    expect(((await screen.findByLabelText("ProbeOne body")) as HTMLSelectElement).value).toBe("remy");
  });
});
