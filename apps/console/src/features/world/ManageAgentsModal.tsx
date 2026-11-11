import { useCallback, useEffect, useState } from "react";
import { api, describeError, type Agent, type Visit, type Wallet } from "../../lib/api";
import { pushToast } from "../../lib/toast";

// The modal is the owner's agent-lifecycle surface: token rotation
// (below), wallet autonomy, and visits — "send this agent into the Verse
// for N minutes, at most M actions." The gateway routes for autonomy and
// visits existed long before this UI did (the claim screen even promised
// "set its wallet and autonomy from the console" while the modal was
// list-and-rotate only); this is the caller they were waiting for.
export function ManageAgentsModal({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const [rotating, setRotating] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ agentId: string; token: string } | null>(null);

  // Bearer-token rotation for a leaked agentToken — the recoverable
  // alternative to killing the agent. New token is shown exactly once, same
  // convention as agent creation and claim-code display.
  async function rotate(agentId: string) {
    if (!confirm("Rotate this agent's token? The old token will stop working immediately.")) return;
    setRotating(agentId);
    try {
      const { agentToken } = await api.rotateAgentToken(agentId);
      setRevealed({ agentId, token: agentToken });
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setRotating(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <b>Manage agents</b>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {agents.length === 0 && <p>You don't own any agents yet.</p>}
        <div className="agent-manage-list">
          {agents.map((a) => (
            <div key={a.id} className="agent-manage-block">
              <div className="agent-manage-row">
                <span>{a.name}</span>
                <button type="button" disabled={rotating === a.id} onClick={() => rotate(a.id)}>
                  {rotating === a.id ? "Rotating…" : "Rotate token"}
                </button>
              </div>
              <AgentLifecycle agent={a} />
            </div>
          ))}
        </div>
        {revealed && (
          <div className="agent-token-reveal">
            <p>
              New token for <b>{agents.find((a) => a.id === revealed.agentId)?.name ?? revealed.agentId}</b> — shown
              once, copy it now:
            </p>
            <code>{revealed.token}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(revealed.token).catch(() => {})}>
              Copy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Autonomy + visit controls for one owned agent. State loads on mount
// (wallet + visit list) and reloads after every mutation, so what the
// owner sees is always the gateway's current rows, not local guesses.
function AgentLifecycle({ agent }: { agent: Agent }) {
  const [autonomy, setAutonomy] = useState<Wallet["autonomyMode"] | null>(null);
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [minutes, setMinutes] = useState(30);
  const [maxActions, setMaxActions] = useState(200);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ wallet }, { visits: rows }] = await Promise.all([api.getWallet(agent.id), api.listVisits(agent.id)]);
      setAutonomy(wallet.autonomyMode);
      setVisits(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeError(err).message);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeAutonomy(mode: Wallet["autonomyMode"]) {
    setBusy(true);
    try {
      const { wallet } = await api.patchWallet(agent.id, { autonomyMode: mode });
      setAutonomy(wallet.autonomyMode);
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function startVisit() {
    setBusy(true);
    try {
      await api.startVisit(agent.id, minutes, maxActions);
      await load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function stopVisit(visitId: string) {
    setBusy(true);
    try {
      await api.stopVisit(agent.id, visitId);
      await load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // The gateway's "active" test: the row hasn't been ended yet.
  const activeVisit = visits?.find((v) => v.endedAt === null) ?? null;

  return (
    <div className="agent-lifecycle">
      <label className="agent-lifecycle-field">
        Autonomy
        <select
          aria-label={`${agent.name} autonomy`}
          value={autonomy ?? ""}
          disabled={autonomy === null || busy}
          onChange={(e) => void changeAutonomy(e.target.value as Wallet["autonomyMode"])}
        >
          {autonomy === null && <option value="">Loading…</option>}
          <option value="observe">observe</option>
          <option value="assist">assist</option>
          <option value="autonomous">autonomous</option>
        </select>
      </label>

      {loadError && <p className="error">{loadError}</p>}

      {visits !== null &&
        (activeVisit ? (
          <div className="agent-visit-active">
            <span>
              Visit active — ends {new Date(activeVisit.endsAt).toLocaleString()} · {activeVisit.actionsUsed}/
              {activeVisit.maxActions} actions used
            </span>
            <button type="button" disabled={busy} onClick={() => void stopVisit(activeVisit.id)}>
              Stop visit
            </button>
          </div>
        ) : (
          <div className="agent-visit-start">
            <label className="agent-lifecycle-field">
              Minutes
              <input
                type="number"
                aria-label={`${agent.name} visit minutes`}
                min={5}
                max={10080}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </label>
            <label className="agent-lifecycle-field">
              Max actions
              <input
                type="number"
                aria-label={`${agent.name} visit max actions`}
                min={1}
                max={100000}
                value={maxActions}
                onChange={(e) => setMaxActions(Number(e.target.value))}
              />
            </label>
            <button type="button" disabled={busy} onClick={() => void startVisit()}>
              Start visit
            </button>
          </div>
        ))}
    </div>
  );
}
