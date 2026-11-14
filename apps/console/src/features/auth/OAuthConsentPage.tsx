import { useEffect, useState } from "react";
import { api, ApiError, describeError, type Agent, type OAuthAuthorizeRequest } from "../../lib/api";
import { oauthScopeLabel } from "../../lib/oauthScopes";

// OAuth 2.1 consent (MCP plan Phase 2): the page GET /oauth/authorize
// parks the owner on after validating the client. The owner picks which
// of their agents the client may act for, narrows the requested scopes,
// and sets how long the delegation lasts; the decision goes back through
// POST /oauth/authorize/decision and this page navigates the browser to
// the client redirect the gateway returns (code on approve,
// access_denied on deny). A request that is unknown, already decided, or
// expired renders a dead end — there is nothing safe to offer but a way
// back to the console.

const GRANT_DAY_OPTIONS = [7, 30, 90];

export function OAuthConsentPage({ onDone }: { onDone: () => void }) {
  const [requestId] = useState(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("request_id") ?? "" : "",
  );
  const [phase, setPhase] = useState<"loading" | "ready" | "invalid" | "submitting">("loading");
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);
  const [request, setRequest] = useState<OAuthAuthorizeRequest | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<ReadonlySet<string>>(new Set());
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(new Set());
  const [grantDays, setGrantDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestId) {
      setInvalidMessage("This page needs a connection request — open the link your app gave you again.");
      setPhase("invalid");
      return;
    }
    let cancelled = false;
    Promise.all([api.oauthAuthorizeRequest(requestId), api.listAgents()])
      .then(([req, agentsRes]) => {
        if (cancelled) return;
        setRequest(req);
        setAgents(agentsRes.agents);
        // The requested scopes start granted; the owner can only narrow
        // from here (the gateway refuses a wider set at decision time).
        setSelectedScopes(new Set(req.scopes));
        setPhase("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setInvalidMessage(
          err instanceof ApiError && err.status === 404
            ? "This connection request is no longer valid — it may have expired or already been answered. Ask the app to connect again."
            : describeError(err).message,
        );
        setPhase("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  function toggle(setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, value: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function decide(approve: boolean) {
    if (phase !== "ready") return;
    setPhase("submitting");
    setError(null);
    try {
      const { redirect } = await api.decideOAuthAuthorize(
        approve
          ? {
              request_id: requestId,
              approve: true,
              agent_ids: [...selectedAgents],
              scopes: [...selectedScopes],
              grant_days: grantDays,
            }
          : { request_id: requestId, approve: false },
      );
      window.location.assign(redirect);
    } catch (err) {
      setError(describeError(err).message);
      setPhase("ready");
    }
  }

  if (phase === "invalid") {
    return (
      <div className="auth-screen">
        <div className="auth-form consent-form">
          <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
          <h1>Request no longer valid</h1>
          <p>{invalidMessage}</p>
          <button type="button" onClick={onDone}>
            Back to console
          </button>
        </div>
      </div>
    );
  }

  if (phase === "loading" || !request) {
    return (
      <div className="auth-screen">
        <div className="auth-form consent-form">
          <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
          <h1>Connect an app</h1>
          <p>Loading the connection request…</p>
        </div>
      </div>
    );
  }

  const submitting = phase === "submitting";
  const canApprove = !submitting && selectedAgents.size > 0 && selectedScopes.size > 0;

  return (
    <div className="auth-screen">
      <div className="auth-form consent-form">
        <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
        <h1>Connect {request.client_name}?</h1>
        <p>
          <strong>{request.client_name}</strong> wants to connect to your AIVerse account. When you decide, you'll
          be sent back to <strong>{request.redirect_host}</strong>. It will never see your password or your agents'
          own keys — you can revoke this connection at any time from Connected clients in the account menu.
        </p>

        <div className="consent-group">
          <b>It will be able to</b>
          <div className="onboarding-options">
            {request.scopes.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={selectedScopes.has(scope)}
                  disabled={submitting}
                  onChange={() => toggle(setSelectedScopes, scope)}
                />
                {oauthScopeLabel(scope)}
              </label>
            ))}
          </div>
        </div>

        <div className="consent-group">
          <b>Acting for these agents</b>
          {agents.length === 0 ? (
            <p>You have no agents yet — claim or create one first, then ask the app to connect again.</p>
          ) : (
            <div className="onboarding-options">
              {agents.map((agent) => (
                <label key={agent.id}>
                  <input
                    type="checkbox"
                    checked={selectedAgents.has(agent.id)}
                    disabled={submitting}
                    onChange={() => toggle(setSelectedAgents, agent.id)}
                  />
                  {agent.name} <small>({agent.status})</small>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="consent-group">
          <b>For how long</b>
          <select
            aria-label="Connection lifetime"
            value={grantDays}
            disabled={submitting}
            onChange={(e) => setGrantDays(Number(e.target.value))}
          >
            {GRANT_DAY_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </div>

        {error && <p className="error">{error}</p>}
        <button type="button" disabled={!canApprove} onClick={() => decide(true)}>
          {submitting ? "Working…" : "Approve connection"}
        </button>
        <button type="button" className="link" disabled={submitting} onClick={() => decide(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
