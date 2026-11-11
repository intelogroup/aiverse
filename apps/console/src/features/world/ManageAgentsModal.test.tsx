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
  startVisit: vi.fn(),
  stopVisit: vi.fn(),
  rotateAgentToken: vi.fn(),
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
  apiMock.startVisit.mockResolvedValue({ visit: activeVisit });
  apiMock.stopVisit.mockResolvedValue({ ok: true });
});

describe("ManageAgentsModal lifecycle controls", () => {
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
});
