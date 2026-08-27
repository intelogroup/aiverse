import type { Agent } from "../../lib/api";

const STATUS_DOT: Record<Agent["status"], string> = {
  online: "🟢",
  away: "🟡",
  offline: "⚪",
  budget_exhausted: "🔴",
  paused: "⏸️",
};

export function AgentsList({
  agents,
  selectedId,
  onSelect,
}: {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="agents-list">
      <h3>My Agents</h3>
      <ul>
        {agents.map((a) => (
          <li key={a.id}>
            <button className={a.id === selectedId ? "active" : ""} onClick={() => onSelect(a.id)}>
              {STATUS_DOT[a.status]} {a.name}
            </button>
          </li>
        ))}
        {agents.length === 0 && <li className="empty">No agents yet.</li>}
      </ul>
    </div>
  );
}
