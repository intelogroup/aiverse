import { useEffect, useState } from "react";
import { api, type Agent, type Wallet } from "../../lib/api";
import { pushToast } from "../../lib/toast";
import { StatusPill } from "../../components/StatusPill";
import { PauseIcon, PlayIcon, SkullIcon } from "../../icons";

type GoalRow = { id: string; objective: string; status: string; contextId: string; updatedAt: string; result?: any };
export function AgentInfoPanel({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [tokensUsed, setTokensUsed] = useState<number | null>(null);
  const [confirmingKill, setConfirmingKill] = useState(false);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [goalTasks, setGoalTasks] = useState<Record<string, number>>({});

  useEffect(() => {
    setConfirmingKill(false);
    api.getWallet(agent.id).then((r) => setWallet(r.wallet));
    api.usageToday(agent.id).then((r) => setTokensUsed(r.tokensUsed));
  }, [agent.id]);

  useEffect(() => {
    let cancelled = false;
    async function pollGoals() {
      try {
        const { goals: all } = await api.listGoals();
        const mine = (all as GoalRow[]).filter((g) => (g as any).agentId === agent.id).slice(0, 3);
        if (cancelled) return;
        setGoals(mine);
        for (const g of mine) {
          try {
            const d = await api.getGoal(g.id);
            if (!cancelled) setGoalTasks((prev) => ({ ...prev, [g.id]: (d.tasks ?? []).length }));
          } catch {}
        }
      } catch {}
    }
    pollGoals();
    const id = setInterval(pollGoals, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [agent.id]);

  async function setAutonomy(mode: Wallet["autonomyMode"]) {
    const r = await api.patchWallet(agent.id, { autonomyMode: mode });
    setWallet(r.wallet);
  }

  async function pause() {
    try {
      await api.pauseAgent(agent.id);
      onChanged();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to pause agent");
    }
  }
  async function resume() {
    try {
      await api.resumeAgent(agent.id);
      onChanged();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "failed to resume agent");
    }
  }
  async function kill() {
    if (!confirmingKill) {
      setConfirmingKill(true);
      return;
    }
    try {
      await api.killAgent(agent.id);
      setConfirmingKill(false);
      onChanged();
    } catch (err) {
      setConfirmingKill(false);
      pushToast(err instanceof Error ? err.message : "failed to kill agent");
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

      {goals.length > 0 && (
        <div className="goals-block">
          <h4>Goals</h4>
          <ul className="goals-list">
            {goals.map((g) => {
              const n = goalTasks[g.id] ?? 0;
              const conflicts = Array.isArray(g.result?.conflicts) ? g.result.conflicts.length : 0;
              const label = g.status === "open" ? "researching"
                : g.status === "researching" ? `${n} responses${conflicts ? ` · ${conflicts} conflicts` : ""} → synthesis pending`
                : g.status === "synthesized" ? "synthesized"
                : g.status;
              return (
                <li key={g.id} className="goal-row">
                  <span className="goal-objective" title={g.objective}>Goal: {g.objective.slice(0, 80)}{g.objective.length>80?"…":""}</span>
                  <span className="goal-meta">{label}{g.result?.summary ? ` · ${String(g.result.summary).slice(0,60)}` : ""}</span>
                </li>
              );
            })}
          </ul>
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
    </div>
  );
}
