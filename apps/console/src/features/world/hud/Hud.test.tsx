import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../../lib/api";

const apiMock = vi.hoisted(() => ({
  listVerseInventory: vi.fn(),
  listVisits: vi.fn(),
  agentConversations: vi.fn(),
  conversationMessages: vi.fn(),
}));
vi.mock("../../../lib/api", () => ({ api: apiMock }));
vi.mock("../VerseRecorder", () => ({ VerseRecorder: () => <button type="button">Record video</button> }));
vi.mock("../VerseShare", () => ({ VerseShare: () => <button type="button">Share</button> }));

import { Hud, type HudProps } from "./Hud";
import { openLongVisit } from "./HudAgents";
import { IDLE_STAGE, hudBridge } from "./hudBridge";

const agent = (id: string, name: string) => ({ id, name }) as Agent;
const actions = { follow: vi.fn(), toggleFollow: vi.fn(), walk: vi.fn(), root: { current: null } };
const account = { email: "o@example.test", unverified: false, resendVerification: vi.fn(), manageAgents: vi.fn(), readKeys: vi.fn(), connectedClients: vi.fn(), changePassword: vi.fn(), logoutAll: vi.fn(), logout: vi.fn() };
const threads = { groups: [], title: () => "", selected: null, select: vi.fn(), messages: [], nameOf: (id: string) => id, searchQ: "", setSearchQ: vi.fn(), searchHits: null, runSearch: vi.fn() };

function show(over: Partial<HudProps> = {}, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const props: HudProps = { agents: [agent("a1", "Ada"), agent("a2", "Bo")], authed: true, liveEvents: [], online: 2, feedDown: false, onRetry: vi.fn(), onSignIn: vi.fn(), threads, account, modalOpen: false, ...over };
  return render(
    <QueryClientProvider client={client}>
      <Hud {...props} />
    </QueryClientProvider>,
  );
}

let unregister: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listVerseInventory.mockResolvedValue({ items: [], energy: 30 });
  apiMock.listVisits.mockResolvedValue({ visits: [] });
  apiMock.agentConversations.mockResolvedValue({ conversations: [] });
  unregister = hudBridge.register(actions);
  hudBridge.publish({ ...IDLE_STAGE, followName: "Ada", present: ["Ada"] });
});
afterEach(() => {
  cleanup();
  unregister();
});

describe("Hud", () => {
  it("shows energy for agents in the world only, with the state in words, and no XP or credits", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Ada energy" }).getAttribute("aria-valuenow")).toBe("30"));
    expect(screen.getByText("30/100 Tired")).toBeTruthy();
    expect(apiMock.listVerseInventory.mock.calls.map((c) => c[0])).toEqual(["a1"]);
    expect(screen.getByText("Away")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/XP|credits|Level/);
  });

  it("keeps the last energy and says when it is from once the gateway stops answering", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    show({}, client);
    await screen.findByText("30/100 Tired");
    apiMock.listVerseInventory.mockRejectedValue(new Error("down"));
    await client.refetchQueries();
    await screen.findByText(/Can't refresh. Values from /);
    expect(screen.getByText("30/100 Tired")).toBeTruthy();
  });

  it("signed out: makes no owner request and shows no owner text", () => {
    show({ authed: false, agents: [] });
    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    expect(screen.getByText("Sign in to read your agents' threads.")).toBeTruthy();
    expect(screen.getByText("Spectating")).toBeTruthy();
    for (const fn of Object.values(apiMock)) expect(fn).not.toHaveBeenCalled();
  });

  it("opens the menu with Esc, holds the account actions, and closes with Esc", () => {
    show();
    fireEvent.keyDown(window, { code: "Escape" });
    for (const name of ["Manage agents", "Verse read keys", "Connected clients", "Change password", "Log out all devices", "Log out"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs");
    fireEvent.keyDown(window, { code: "KeyF" });
    expect(actions.toggleFollow).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { code: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs hotkeys, and none of them while walking", () => {
    show();
    fireEvent.keyDown(window, { code: "KeyF" });
    fireEvent.keyDown(window, { code: "KeyT" });
    expect([actions.toggleFollow.mock.calls.length, actions.walk.mock.calls.length]).toEqual([1, 1]);
    hudBridge.publish({ ...IDLE_STAGE, walking: true });
    fireEvent.keyDown(window, { code: "Escape" });
    fireEvent.keyDown(window, { code: "KeyF" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.toggleFollow).toHaveBeenCalledTimes(1);
  });
});

describe("openLongVisit", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const visit = (startedAt: string, endsAt: string, endedAt: string | null = null) => ({ startedAt, endsAt, endedAt }) as never;
  it("ignores short presence visits and ended ones", () => {
    expect(openLongVisit([visit("2026-01-01T11:59:00Z", "2026-01-01T12:02:00Z")], now)).toBeNull();
    expect(openLongVisit([visit("2026-01-01T11:00:00Z", "2026-01-01T13:00:00Z", "2026-01-01T11:30:00Z")], now)).toBeNull();
    expect(openLongVisit([visit("2026-01-01T11:00:00Z", "2026-01-01T13:00:00Z")], now)).not.toBeNull();
  });
});
