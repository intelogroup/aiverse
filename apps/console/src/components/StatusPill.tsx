export type AgentStatus = "online" | "away" | "offline" | "budget_exhausted" | "paused";

const LABEL: Record<AgentStatus, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
  budget_exhausted: "Budget exhausted",
  paused: "Paused",
};

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" />
      {LABEL[status]}
    </span>
  );
}
