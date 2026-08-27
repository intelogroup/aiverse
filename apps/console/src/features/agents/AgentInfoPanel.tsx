import { useEffect, useState } from "react";
import { api, type Agent, type Wallet } from "../../lib/api";
import { StatusPill } from "../../components/StatusPill";
import { PauseIcon, PlayIcon, SkullIcon } from "../../icons";

export function AgentInfoPanel({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [tokensUsed, setTokensUsed] = useState<number | null>(null);
  const [confirmingKill, setConfirmingKill] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setConfirmingKill(false);
    setActionError(null);
    api.getWallet(agent.id).then((r) => setWallet(r.wallet));
    api.usageToday(agent.id).then((r) => setTokensUsed(r.tokensUsed));
  }, [agent.id]);

  async function setAutonomy(mode: Wallet["autonomyMode"]) {
    const r = await api.patchWallet(agent.id, { autonomyMode: mode });
    setWallet(r.wallet);
  }

  async function pause() {
    setActionError(null);
    try {
      await api.pauseAgent(agent.id);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "failed to pause agent");
    }
  }
  async function resume() {
    setActionError(null);
    try {
      await api.resumeAgent(agent.id);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "failed to resume agent");
    }
  }
  async function kill() {
    if (!confirmingKill) {
      setConfirmingKill(true);
      return;
    }
    setActionError(null);
    try {
      await api.killAgent(agent.id);
      setConfirmingKill(false);
      onChanged();
    } catch (err) {
      setConfirmingKill(false);
      setActionError(err instanceof Error ? err.message : "failed to kill agent");
    }
  }

  const used = tokensUsed ?? 0;
  const budget = wallet?.dailyTokenBudget ?? 0;
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;

  return (
    <div className="agent-info-panel">
      <div className="agent-info-header">
        <h3>{agent.name}</h3>
        <StatusPill status={agent.status} />
      </div>
      <div className="capability-chips">
        {agent.agentCard.capabilities.length === 0 ? (
          <span className="capabilities">no capabilities</span>
        ) : (
          agent.agentCard.capabilities.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))
        )}
      </div>

      <div className="autonomy-dial">
        <span>Autonomy</span>
        <div className="segmented">
          {(["observe", "assist", "autonomous"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={wallet?.autonomyMode === mode ? "active" : ""}
              onClick={() => setAutonomy(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {wallet && (
        <div className="budget-block">
          <div className="budget-block-labels">
            <span>Daily token budget</span>
            <span>
              {used.toLocaleString()} / {budget.toLocaleString()}
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="controls">
        {agent.status === "paused" ? (
          <button type="button" className="icon-button-labeled" onClick={resume} aria-label="Resume agent">
            <PlayIcon /> Resume
          </button>
        ) : (
          <button type="button" className="icon-button-labeled" onClick={pause} aria-label="Pause agent">
            <PauseIcon /> Pause
          </button>
        )}
        <button
          type="button"
          className="icon-button-labeled danger"
          onClick={kill}
          aria-label="Kill agent"
        >
          <SkullIcon /> {confirmingKill ? "Confirm kill?" : "Kill"}
        </button>
        {confirmingKill && (
          <button type="button" className="link" onClick={() => setConfirmingKill(false)}>
            cancel
          </button>
        )}
      </div>
      {actionError && <p className="error">{actionError}</p>}
    </div>
  );
}
