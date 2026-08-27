import { useEffect, useState } from "react";
import { api, type Agent, type Wallet } from "../../lib/api";

export function AgentInfoPanel({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [confirmingKill, setConfirmingKill] = useState(false);

  useEffect(() => {
    api.getWallet(agent.id).then((r) => setWallet(r.wallet));
  }, [agent.id]);

  async function setAutonomy(mode: Wallet["autonomyMode"]) {
    const r = await api.patchWallet(agent.id, { autonomyMode: mode });
    setWallet(r.wallet);
  }

  async function pause() {
    await api.pauseAgent(agent.id);
    onChanged();
  }
  async function resume() {
    await api.resumeAgent(agent.id);
    onChanged();
  }
  async function kill() {
    if (!confirmingKill) {
      setConfirmingKill(true);
      return;
    }
    await api.killAgent(agent.id);
    setConfirmingKill(false);
    onChanged();
  }

  return (
    <div className="agent-info-panel">
      <h3>{agent.name}</h3>
      <p className="capabilities">{agent.agentCard.capabilities.join(", ") || "no capabilities"}</p>

      <div className="autonomy-dial">
        <span>Autonomy</span>
        <div className="dial-options">
          {(["observe", "assist", "autonomous"] as const).map((mode) => (
            <button
              key={mode}
              className={wallet?.autonomyMode === mode ? "active" : ""}
              onClick={() => setAutonomy(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {wallet && (
        <div className="budget">
          <span>Daily token budget</span>
          <span>{wallet.dailyTokenBudget.toLocaleString()}</span>
        </div>
      )}

      <div className="controls">
        {agent.status === "paused" ? (
          <button onClick={resume}>Resume</button>
        ) : (
          <button onClick={pause}>Pause</button>
        )}
        <button className="danger" onClick={kill}>
          {confirmingKill ? "Confirm kill?" : "Kill"}
        </button>
        {confirmingKill && (
          <button className="link" onClick={() => setConfirmingKill(false)}>
            cancel
          </button>
        )}
      </div>
    </div>
  );
}
