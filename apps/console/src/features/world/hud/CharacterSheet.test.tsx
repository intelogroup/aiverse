// The Manage agents checklist, run against the sheet: the same actions and client calls, reached
// through tabs.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Visit, Wallet } from "../../../lib/api";

const apiMock = vi.hoisted(() => ({
  getWallet: vi.fn(),
  usageToday: vi.fn(),
  patchWallet: vi.fn(),
  listVisits: vi.fn(),
  listVerseInventory: vi.fn(),
  listVerseMemory: vi.fn(),
  listCabinInvitations: vi.fn(),
  listHuntReceipts: vi.fn(),
  startVisit: vi.fn(),
  stopVisit: vi.fn(),
  rotateAgentToken: vi.fn(),
  setAgentBody: vi.fn(),
}));
vi.mock("../../../lib/api", () => ({
  api: apiMock,
  describeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));
vi.mock("../../../lib/toast", () => ({ pushToast: vi.fn() }));

import { CharacterSheet } from "./CharacterSheet";

const agents = [
  { id: "a1", name: "Ada" },
  { id: "a2", name: "Bo", body: "eve" },
] as Agent[];
const visit = { id: "v1", agentId: "a1", endsAt: new Date(Date.now() + 60_000).toISOString(), maxActions: 200, actionsUsed: 3, endedAt: null } as Visit;

function show(props: Partial<Parameters<typeof CharacterSheet>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="world-root">
        <CharacterSheet agents={agents} onClose={() => {}} {...props} />
      </div>
    </QueryClientProvider>,
  );
}
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getWallet.mockResolvedValue({ wallet: { autonomyMode: "observe", dailyTokenBudget: 500000 } as Wallet });
  apiMock.usageToday.mockResolvedValue({ tokensUsed: 1200 });
  apiMock.patchWallet.mockResolvedValue({ wallet: { autonomyMode: "autonomous" } });
  apiMock.listVisits.mockResolvedValue({ visits: [] });
  apiMock.listVerseInventory.mockResolvedValue({
    items: [{ id: "i1", name: "Ceramic token" }], energy: 67, progress: { credits: 3, xp: 5, level: 1, nextLevelXp: 100 },
    receipts: [{ id: "s1", itemName: "Ceramic token", price: 2, side: "bought" }],
  });
  apiMock.listVerseMemory.mockResolvedValue({ memory: [{ id: "m1", tier: "note", kind: "note", text: "Met Bo at the hall" }] });
  apiMock.listCabinInvitations.mockResolvedValue({ enabled: true, invitations: [] });
  apiMock.listHuntReceipts.mockResolvedValue({ receipts: [{ contestId: "tea-hunt", payload: "<img src=x>", credits: 10 }] });
  apiMock.startVisit.mockResolvedValue({});
  apiMock.stopVisit.mockResolvedValue({ ok: true });
  apiMock.rotateAgentToken.mockResolvedValue({ agentToken: "new-token-value" });
  apiMock.setAgentBody.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CharacterSheet", () => {
  it("Agent tab: shows energy and level, changes the body and starts a visit", async () => {
    show();
    await screen.findByText("Energy 67/100 · Level 1 · 5 XP");
    fireEvent.change(screen.getByLabelText("Ada body"), { target: { value: "eve" } });
    await waitFor(() => expect(apiMock.setAgentBody).toHaveBeenCalledWith("a1", "eve"));
    fireEvent.click(await screen.findByRole("button", { name: "Start visit" }));
    await waitFor(() => expect(apiMock.startVisit).toHaveBeenCalledWith("a1", 30, 200));
  });

  it("Agent tab: stops an active visit", async () => {
    apiMock.listVisits.mockResolvedValue({ visits: [visit] });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Stop visit" }));
    await waitFor(() => expect(apiMock.stopVisit).toHaveBeenCalledWith("a1", "v1"));
  });

  it("Bag tab: loads on demand with items, credits and sales, and refreshes", async () => {
    show();
    expect(screen.queryByText("Ceramic token")).toBeNull();
    tab("Bag");
    await screen.findByText("Ceramic token");
    expect(screen.getByText("3 credits · 5 XP")).toBeTruthy();
    expect(screen.getByText("Bought Ceramic token for 2 credits")).toBeTruthy();
    const before = apiMock.listVerseInventory.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));
    await waitFor(() => expect(apiMock.listVerseInventory.mock.calls.length).toBeGreaterThan(before));
  });

  it("Journal tab: memory, invitations, and bounty receipts copied only on request", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show();
    expect(apiMock.listVerseMemory).not.toHaveBeenCalled();
    tab("Journal");
    await screen.findByText("Met Bo at the hall");
    await screen.findByText("No cabin invitations yet.");
    expect(apiMock.listHuntReceipts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View bounty receipts" }));
    await screen.findByText("<img src=x>");
    expect(screen.queryByRole("img")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(writeText).toHaveBeenCalledWith("<img src=x>");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("Permissions tab: autonomy, token budget, and token rotation after a confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    show();
    tab("Permissions");
    await screen.findByText("1,200 of 500,000 tokens used today");
    const select = screen.getByLabelText("Ada autonomy") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("observe"));
    fireEvent.change(select, { target: { value: "autonomous" } });
    await waitFor(() => expect(apiMock.patchWallet).toHaveBeenCalledWith("a1", { autonomyMode: "autonomous" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    expect(apiMock.rotateAgentToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    await screen.findByText("new-token-value");
    // Switching agent must not carry the token over.
    fireEvent.click(screen.getByRole("button", { name: "Bo" }));
    expect(screen.queryByText("new-token-value")).toBeNull();
  });

  it("opens the followed agent, moves focus in, switches tab by arrow, and Esc returns focus", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Opener</button>
          {open ? <CharacterSheet agents={agents} initialName="Bo" onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Host />
      </QueryClientProvider>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "Bo" }).getAttribute("aria-pressed")).toBe("true");
    const agentTab = screen.getByRole("tab", { name: "Agent" });
    expect(document.activeElement).toBe(agentTab);
    fireEvent.keyDown(agentTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Bag" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
