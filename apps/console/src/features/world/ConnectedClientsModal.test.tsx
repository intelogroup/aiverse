import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthGrant } from "../../lib/api";

// The Connected clients modal is the owner's revocation surface for
// OAuth delegations: these tests pin that grants render with resolved
// names and plain-words scopes, that only active grants offer a Revoke
// action, and that revoking issues the client call and reloads.
const apiMock = vi.hoisted(() => ({
  listOAuthGrants: vi.fn(),
  revokeOAuthGrant: vi.fn(),
}));
vi.mock("../../lib/api", () => ({
  api: apiMock,
  describeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));
vi.mock("../../lib/toast", () => ({ pushToast: vi.fn() }));

import { ConnectedClientsModal } from "./ConnectedClientsModal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const activeGrant: OAuthGrant = {
  id: "grant-1",
  client_id: "client-1",
  client_name: "My MCP App",
  agent_ids: ["agent-1"],
  agent_names: { "agent-1": "ProbeOne" },
  scopes: ["world:act", "inbox:read"],
  created_at: new Date(Date.now() - 60_000).toISOString(),
  expires_at: new Date(Date.now() + 29 * 24 * 60 * 60_000).toISOString(),
  revoked_at: null,
};

const revokedGrant: OAuthGrant = {
  id: "grant-2",
  client_id: "client-2",
  client_name: "Old Harness",
  agent_ids: ["agent-2"],
  agent_names: { "agent-2": "SecondBot" },
  scopes: ["discover"],
  created_at: new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString(),
  revoked_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("confirm", vi.fn(() => true));
  apiMock.listOAuthGrants.mockResolvedValue({ grants: [activeGrant, revokedGrant] });
  apiMock.revokeOAuthGrant.mockResolvedValue({ ok: true });
});

describe("ConnectedClientsModal", () => {
  it("renders active grants with names and plain-words scopes; revoked grants show as inactive", async () => {
    render(<ConnectedClientsModal onClose={() => {}} />);
    expect(await screen.findByText("My MCP App")).toBeTruthy();
    expect(screen.getByText(/For ProbeOne/)).toBeTruthy();
    expect(screen.getByText(/Move, speak and act in the Verse · Read your agent's inbox/)).toBeTruthy();

    expect(screen.getByText("Old Harness")).toBeTruthy();
    expect(screen.getByText(/Revoked/)).toBeTruthy();
    // Only the active grant offers a Revoke action.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("revoking calls the client and reloads the list", async () => {
    render(<ConnectedClientsModal onClose={() => {}} />);
    await screen.findByText("My MCP App");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(apiMock.revokeOAuthGrant).toHaveBeenCalledWith("grant-1"));
    await waitFor(() => expect(apiMock.listOAuthGrants).toHaveBeenCalledTimes(2));
  });

  it("shows the empty state when the owner has no grants", async () => {
    apiMock.listOAuthGrants.mockResolvedValue({ grants: [] });
    render(<ConnectedClientsModal onClose={() => {}} />);
    expect(await screen.findByText("No connected clients yet.")).toBeTruthy();
  });
});
