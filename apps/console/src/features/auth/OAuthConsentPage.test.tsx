import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

// The consent page is the human half of the OAuth delegation: these tests
// pin that it renders exactly the parked request (client, return host,
// requested scopes pre-granted), that Approve stays disabled until the
// owner has picked at least one agent and one scope, and that the
// decision posts the owner's narrowed set — never a wider one — before
// navigating to the gateway's returned redirect.
const apiMock = vi.hoisted(() => ({
  oauthAuthorizeRequest: vi.fn(),
  listAgents: vi.fn(),
  decideOAuthAuthorize: vi.fn(),
}));
vi.mock("../../lib/api", () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: apiMock,
    ApiError: MockApiError,
    describeError: (err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      kind: "error" as const,
    }),
  };
});

import { OAuthConsentPage } from "./OAuthConsentPage";

afterEach(() => cleanup());

const assignMock = vi.fn();
const originalLocation = window.location;

function setLocation(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { search, assign: assignMock, href: `http://localhost/oauth/consent${search}` },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

const agent = {
  id: "agent-1",
  name: "ProbeOne",
  agentCard: { capabilities: [] },
  status: "offline",
};

const parkedRequest = {
  client_name: "Test MCP Client",
  client_id: "client-1",
  redirect_host: "localhost:53111",
  scopes: ["world:observe", "world:act"],
  expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
};

const CLIENT_REDIRECT = "http://localhost:53111/oauth-callback?code=abc&state=state-123";

beforeEach(() => {
  vi.clearAllMocks();
  assignMock.mockClear();
  setLocation("?request_id=req-1");
  apiMock.oauthAuthorizeRequest.mockResolvedValue(parkedRequest);
  apiMock.listAgents.mockResolvedValue({ agents: [agent] });
  apiMock.decideOAuthAuthorize.mockResolvedValue({ redirect: CLIENT_REDIRECT });
});

describe("OAuthConsentPage", () => {
  it("renders the client, the return host, requested scopes pre-granted, and no agent preselected", async () => {
    render(<OAuthConsentPage onDone={() => {}} />);
    expect(await screen.findByText(/Connect Test MCP Client\?/)).toBeTruthy();
    expect(screen.getByText("localhost:53111")).toBeTruthy();

    const observe = screen.getByLabelText("See what your agent sees in the Verse") as HTMLInputElement;
    const act = screen.getByLabelText("Move, speak and act in the Verse") as HTMLInputElement;
    expect(observe.checked).toBe(true);
    expect(act.checked).toBe(true);

    const agentBox = screen.getByLabelText(/ProbeOne/) as HTMLInputElement;
    expect(agentBox.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Approve connection" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("approve posts the owner's narrowed scopes, chosen agent, and lifetime, then navigates to the redirect", async () => {
    render(<OAuthConsentPage onDone={() => {}} />);
    await screen.findByText(/Connect Test MCP Client\?/);

    fireEvent.click(screen.getByLabelText("Move, speak and act in the Verse"));
    fireEvent.click(screen.getByLabelText(/ProbeOne/));
    fireEvent.change(screen.getByLabelText("Connection lifetime"), { target: { value: "7" } });

    const approve = screen.getByRole("button", { name: "Approve connection" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);

    await waitFor(() =>
      expect(apiMock.decideOAuthAuthorize).toHaveBeenCalledWith({
        request_id: "req-1",
        approve: true,
        agent_ids: ["agent-1"],
        scopes: ["world:observe"],
        grant_days: 7,
      }),
    );
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith(CLIENT_REDIRECT));
  });

  it("deny posts approve:false with nothing else and navigates to the returned redirect", async () => {
    render(<OAuthConsentPage onDone={() => {}} />);
    await screen.findByText(/Connect Test MCP Client\?/);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(apiMock.decideOAuthAuthorize).toHaveBeenCalledWith({ request_id: "req-1", approve: false }),
    );
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith(CLIENT_REDIRECT));
  });

  it("a 404 request renders a dead end with no live decision buttons", async () => {
    apiMock.oauthAuthorizeRequest.mockRejectedValue(new ApiError(404, "not_found"));
    const onDone = vi.fn();
    render(<OAuthConsentPage onDone={onDone} />);
    expect(await screen.findByRole("heading", { name: "Request no longer valid" })).toBeTruthy();
    expect(screen.getByText(/may have expired or already been answered/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to console" }));
    expect(onDone).toHaveBeenCalled();
  });
});
