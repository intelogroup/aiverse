import { api, type Agent, type Wallet } from "../lib/api";
import { useEffect, useState } from "react";

export interface LedgerRow {
  agent: Agent;
  lastAction: string;
  sends: number;
  joins: number;
}

export function Ledger({
  rows,
  selectedId,
  onSelect,
}: {
  rows: LedgerRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="ledger">
      <h3>Ledger · your agents</h3>
      {rows.length === 0 && <p style={{ color: "var(--faint)", padding: "0 12px 10px", fontSize: 12 }}>no agents</p>}
      {rows.map(({ agent, lastAction, sends, joins }) => (
        <button
          key={agent.id}
          className={`ledger-row ${agent.id === selectedId ? "active" : ""}`}
          onClick={() => onSelect(agent.id)}
        >
          <span className={`dot-sm ${agent.status === "online" || agent.status === "away" ? "on" : "off"}`} />
          <span className="ledger-name">{agent.name}</span>
          <span className="ledger-act">{lastAction || "—"}</span>
          <span className="ledger-metrics">{sends}✉ {joins}↵</span>
        </button>
      ))}
    </div>
  );
}

export function AgentFocus({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);

  useEffect(() => {
    setConfirmKill(false);
    api.getWallet(agent.id).then((r) => setWallet(r.wallet)).catch(() => {});
  }, [agent.id]);

  async function setAutonomy(mode: Wallet["autonomyMode"]) {
    try {
      const r = await api.setAutonomy(agent.id, mode);
      setWallet(r.wallet);
    } catch {}
  }
  async function togglePause() {
    try {
      if (agent.status === "paused") await api.resumeAgent(agent.id);
      else await api.pauseAgent(agent.id);
      onChanged();
    } catch {}
  }
  async function kill() {
    if (!confirmKill) return setConfirmKill(true);
    try {
      await api.killAgent(agent.id);
      setConfirmKill(false);
      onChanged();
    } catch {}
  }

  return (
    <div className="focus">
      <h4>{agent.name}</h4>
      <div className="caps">
        {agent.agentCard.capabilities.map((c) => (
          <span key={c} className="chip">{c}</span>
        ))}
      </div>
      <div className="kv"><span>status</span><span>{agent.status}</span></div>
      <div className="kv"><span>last seen</span><span>{agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleTimeString() : "never"}</span></div>
      {wallet && (
        <div className="kv"><span>budget</span><span>{wallet.dailyTokenBudget.toLocaleString()} / day</span></div>
      )}
      {wallet && (
        <div style={{ margin: "12px 0 0" }}>
          <div style={{ color: "var(--dim)", fontSize: 11.5, marginBottom: 6 }}>autonomy</div>
          <div className="seg">
            {(["observe", "assist", "autonomous"] as const).map((m) => (
              <button key={m} className={wallet.autonomyMode === m ? "active" : ""} onClick={() => setAutonomy(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="controls">
        <button className="btn" onClick={togglePause}>{agent.status === "paused" ? "Resume" : "Pause"}</button>
        <button className="btn danger" onClick={kill}>{confirmKill ? "Confirm kill?" : "Kill"}</button>
      </div>
    </div>
  );
}
