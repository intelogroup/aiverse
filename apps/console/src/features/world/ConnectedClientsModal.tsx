import { useEffect, useState } from "react";
import { api, describeError, type OAuthGrant } from "../../lib/api";
import { oauthScopeLabel } from "../../lib/oauthScopes";
import { pushToast } from "../../lib/toast";

// Connected clients (MCP plan Phase 2): the OAuth 2.1 delegations this
// owner has granted — external apps/harnesses that can act for specific
// agents within specific scopes. Revoking is checked per-request by the
// gateway against oauth_grants, so it takes effect immediately, not at
// access-token expiry. The read-keys modal next door is the read-only
// counterpart: those keys can only watch; these clients can act.
export function ConnectedClientsModal({ onClose }: { onClose: () => void }) {
  const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  function load() {
    api
      .listOAuthGrants()
      .then((r) => setGrants(r.grants))
      .catch((err) => pushToast(describeError(err).message, "error"));
  }

  useEffect(load, []);

  async function revoke(grant: OAuthGrant) {
    if (
      !confirm(
        `Revoke ${grant.client_name}? It will no longer be able to act for these agents — this takes effect immediately.`,
      )
    )
      return;
    setRevoking(grant.id);
    try {
      await api.revokeOAuthGrant(grant.id);
      load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setRevoking(null);
    }
  }

  const now = Date.now();
  const isActive = (g: OAuthGrant) => !g.revoked_at && new Date(g.expires_at).getTime() > now;
  const active = (grants ?? []).filter(isActive);
  const inactive = (grants ?? []).filter((g) => !isActive(g));

  function grantDetail(g: OAuthGrant) {
    const names = g.agent_ids.map((id) => g.agent_names[id] ?? "Unknown agent").join(", ");
    const scopes = g.scopes.map(oauthScopeLabel).join(" · ");
    return (
      <>
        {g.client_name}
        <br />
        <small>
          For {names}
          <br />
          {scopes}
          <br />
          Connected {new Date(g.created_at).toLocaleString()} · until {new Date(g.expires_at).toLocaleString()}
        </small>
      </>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <b>Connected clients</b>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="read-key-intro">
          Apps and tools you've authorized to act for your agents in the Verse — for example an MCP client you
          connected from the consent page. They act only for the agents and abilities listed, and revoking a
          connection cuts it off immediately.
        </p>

        {grants === null && <p>Loading…</p>}
        {grants !== null && active.length === 0 && inactive.length === 0 && <p>No connected clients yet.</p>}

        {active.length > 0 && (
          <div className="agent-manage-list">
            {active.map((g) => (
              <div key={g.id} className="agent-manage-row">
                <span>{grantDetail(g)}</span>
                <button type="button" disabled={revoking === g.id} onClick={() => revoke(g)}>
                  {revoking === g.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        )}

        {inactive.length > 0 && (
          <div className="agent-manage-list">
            {inactive.map((g) => (
              <div key={g.id} className="agent-manage-row">
                <span>
                  {grantDetail(g)}
                  <br />
                  <small>
                    {g.revoked_at
                      ? `Revoked ${new Date(g.revoked_at).toLocaleString()}`
                      : `Expired ${new Date(g.expires_at).toLocaleString()}`}
                  </small>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
