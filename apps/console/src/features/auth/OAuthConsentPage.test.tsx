import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

// The consent page is the human half of the OAuth delegation: these tests
// pin that it renders exactly the parked request (client, return host,
// requested scopes pre-granted), that Approve stays disabled until the
// owner has picked at least one agent and one scope, and that the
// decision posts the owner's narrowed set — never a wider one — before
// navigating to the gateway's returned redirect. They also pin the F2
// in-flow claim: an owner with no agents claims one from this page and
// approves the same parked request, instead of hitting a dead end.
const apiMock = vi.hoisted(() => ({
  oauthAuthorizeRequest: vi.fn(),
  listAgents: vi.fn(),
  decideOAuthAuthorize: vi.fn(),
  claimAgent: vi.fn(),
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
  apiMock.claimAgent.mockResolvedValue({
    agent: { id: "agent-1", name: "ProbeOne", status: "offline" },
    visit: null,
  });
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

  it("with no agents, the page offers an in-flow claim instead of a dead end (F2)", async () => {
    apiMock.listAgents.mockResolvedValue({ agents: [] });
    render(<OAuthConsentPage onDone={() => {}} />);
    expect(await screen.findByText(/You have no agents yet/)).toBeTruthy();
    // The claim path is right here: a code input, register guidance,
    // and a claim button — while Approve stays disabled (nothing to
    // approve for yet).
    expect(screen.getByLabelText("Claim code")).toBeTruthy();
    expect(screen.getByText(/POST \/agents\/register/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim agent" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve connection" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.decideOAuthAuthorize).not.toHaveBeenCalled();
  });

  it("claiming in flow selects the claimed agent and the SAME request approves (F2)", async () => {
    apiMock.listAgents.mockResolvedValueOnce({ agents: [] }).mockResolvedValue({ agents: [agent] });
    render(<OAuthConsentPage onDone={() => {}} />);
    const input = (await screen.findByLabelText("Claim code")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "claim-xyz" } });
    fireEvent.click(screen.getByRole("button", { name: "Claim agent" }));
    await waitFor(() => expect(apiMock.claimAgent).toHaveBeenCalledWith("claim-xyz"));

    // The claimed agent appears, pre-selected, with the confirmation…
    const agentBox = (await screen.findByLabelText(/ProbeOne/)) as HTMLInputElement;
    await waitFor(() => expect(agentBox.checked).toBe(true));
    expect(await screen.findByText(/Claimed/)).toBeTruthy();

    // …and approving posts the decision against the original request.
    const approve = screen.getByRole("button", { name: "Approve connection" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(apiMock.decideOAuthAuthorize).toHaveBeenCalledWith({
        request_id: "req-1",
        approve: true,
        agent_ids: ["agent-1"],
        scopes: ["world:observe", "world:act"],
        grant_days: 30,
      }),
    );
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith(CLIENT_REDIRECT));
  });

  it("a failed claim shows the error and keeps the form live (F2)", async () => {
    apiMock.listAgents.mockResolvedValue({ agents: [] });
    apiMock.claimAgent.mockRejectedValue(new ApiError(400, "invalid claim code"));
    render(<OAuthConsentPage onDone={() => {}} />);
    const input = (await screen.findByLabelText("Claim code")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bogus-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Claim agent" }));
    expect(await screen.findByText(/invalid claim code/)).toBeTruthy();
    // Nothing was decided, Approve is still disabled, and the form can
    // be retried with a corrected code.
    expect(apiMock.decideOAuthAuthorize).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Approve connection" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Claim agent" }) as HTMLButtonElement).disabled).toBe(false);
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
