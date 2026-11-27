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
const actions = { follow: vi.fn(), toggleFollow: vi.fn(), walk: vi.fn(), bodies: vi.fn(() => [{ name: "Ada", x: 35, z: -74 }, { name: "Zed", x: 0, z: 0 }]), focus: vi.fn(() => null), root: { current: null } };
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
  it("shows energy for agents in the world only, with the state in words", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Ada energy" }).getAttribute("aria-valuenow")).toBe("30"));
    expect(screen.getByText("30/100 Tired")).toBeTruthy();
    expect(apiMock.listVerseInventory.mock.calls.map((c) => c[0])).toEqual(["a1"]);
    expect(screen.getByText("Away")).toBeTruthy();
  });

  it("flag off: says progress is not tracked and draws no XP bar, level or credits", async () => {
    show();
    await screen.findByText("XP and credits are not tracked here.");
    expect(screen.queryByRole("progressbar", { name: "Ada XP" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Level \d|\d credits|\d XP/);
  });

  it("shows level, lifetime XP and credits, and toasts only when a later value is higher", async () => {
    const progress = { credits: 4, xp: 120, level: 2, nextLevelXp: 400 };
    apiMock.listVerseInventory.mockResolvedValue({ items: [], energy: 80, progress });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    show({}, client);
    const bar = await screen.findByRole("progressbar", { name: "Ada XP" });
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax")]).toEqual(["120", "400"]);
    expect(screen.getByText("120 of 400 XP")).toBeTruthy();
    expect(screen.getByText("Level 2")).toBeTruthy();
    expect(screen.getByText("4 credits")).toBeTruthy();
    const toasts = screen.getByRole("log", { name: "Gains" });
    expect(toasts.textContent).toBe("");
    apiMock.listVerseInventory.mockResolvedValue({ items: [], energy: 80, progress: { ...progress, credits: 1 } });
    await client.refetchQueries();
    await screen.findByText("1 credits");
    expect(toasts.textContent).toBe("");
    apiMock.listVerseInventory.mockResolvedValue({ items: [], energy: 80, progress: { credits: 4, xp: 400, level: 3, nextLevelXp: 900 } });
    await client.refetchQueries();
    await waitFor(() => expect(toasts.textContent).toBe("Ada: +280 XP, +3 credits, level 3"));
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

describe("HudMap", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("places") ? [{ id: "hall-0", name: "Market Hall", pos: [35, -76.5] }, { id: "stall-0", name: "stall-0", pos: [35, -74] }] : []),
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names the nearest place to the followed agent and marks own dots apart from others", async () => {
    hudBridge.publish({ ...IDLE_STAGE, following: true, followName: "Ada", present: ["Ada", "Zed"] });
    show();
    await screen.findByText("near Market Hall");
    expect(document.querySelector('circle[data-name="Ada"]')?.getAttribute("class")).toBe("mine");
    expect(document.querySelector('circle[data-name="Zed"]')?.getAttribute("class")).toBe("other");
  });

  it("follows positions within one poll, and M enlarges the map", async () => {
    show();
    actions.bodies.mockReturnValue([{ name: "Ada", x: -50, z: 60 }]);
    await waitFor(() => expect(document.querySelector('circle[data-name="Ada"]')?.getAttribute("cx")).toBe("-50"), { timeout: 900 });
    expect(document.querySelector('circle[data-name="Zed"]')).toBeNull();
    fireEvent.keyDown(window, { code: "KeyM" });
    expect(screen.getByRole("button", { name: "Shrink map" })).toBeTruthy();
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
