import { useState } from "react";
import { api, describeError, type Agent } from "../../lib/api";
import { pushToast } from "../../lib/toast";

// Bearer-token rotation for a leaked agentToken — the recoverable
// alternative to killing the agent. New token is shown exactly once, same
// convention as agent creation and claim-code display.
export function ManageAgentsModal({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const [rotating, setRotating] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ agentId: string; token: string } | null>(null);

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
            <div key={a.id} className="agent-manage-row">
              <span>{a.name}</span>
              <button type="button" disabled={rotating === a.id} onClick={() => rotate(a.id)}>
                {rotating === a.id ? "Rotating…" : "Rotate token"}
              </button>
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
