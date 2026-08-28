import type { Agent } from "../../lib/api";
import { StatusPill } from "../../components/StatusPill";
import { EmptyState } from "../../components/EmptyState";
import { SkeletonRows } from "../../components/Skeleton";
import { BotIcon } from "../../icons";

function relativeTime(iso?: string): string {
  if (!iso) return "never seen";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function AgentsList({
  agents,
  loading,
  selectedId,
  onSelect,
  onCreate,
}: {
  agents: Agent[];
  loading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  // Derived sections: Live / Authenticated / Never / Paused+budget — no new API, just status+lastSeenAt
  const live = agents.filter((a) => a.status === "online" || a.status === "away");
  const auth = agents.filter((a) => a.status === "offline" && !!a.lastSeenAt);
  const never = agents.filter((a) => !a.lastSeenAt);
  const paused = agents.filter((a) => a.status === "paused" || a.status === "budget_exhausted");

  function Row({ a }: { a: Agent }) {
    return (
      <li key={a.id}>
        <button
          type="button"
          className={`agent-row ${a.id === selectedId ? "active" : ""}`}
          onClick={() => onSelect(a.id)}
        >
          <span className="avatar">{initials(a.name)}</span>
          <span className="agent-row-main">
            <span className="agent-row-name">{a.name}</span>
            <StatusPill status={a.status} />
          </span>
          <span className="agent-row-seen">{relativeTime(a.lastSeenAt)}</span>
        </button>
      </li>
    );
  }

  return (
    <div className="agents-list">
      <h3>
        My Agents · {agents.length} total · {live.length} live · {auth.length} authenticated · {never.length} never
      </h3>
      {loading ? (
        <SkeletonRows />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<BotIcon />}
          text="No agents yet"
          hint="Create one to give it identity, a token, and a place in the network."
          action={{ label: "Create your first agent", onClick: onCreate }}
        />
      ) : (
        <>
          {live.length > 0 && (
            <>
              <h4>Live</h4>
              <ul>
                {live.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </ul>
            </>
          )}
          {auth.length > 0 && (
            <>
              <h4>Authenticated / offline</h4>
              <ul>
                {auth.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </ul>
            </>
          )}
          {never.length > 0 && (
            <>
              <h4>Never connected</h4>
              <ul>
                {never.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </ul>
            </>
          )}
          {paused.length > 0 && (
            <>
              <h4>Paused / budget exhausted</h4>
              <ul>
                {paused.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
