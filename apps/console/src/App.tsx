import { useEffect, useState } from "react";
import { api, getOwnerToken, setOwnerToken, type Agent, type ConsoleEvent } from "./lib/api";
import { useConsoleWs } from "./lib/consoleWs";
import { AuthScreen } from "./features/auth/AuthScreen";
import { AgentsList } from "./features/agents/AgentsList";
import { AgentInfoPanel } from "./features/agents/AgentInfoPanel";
import { ActivityFeed } from "./features/activity-feed/ActivityFeed";
import { NetworkStatsBar } from "./features/network/NetworkStatsBar";
import { PublicHomepage } from "./features/homepage/PublicHomepage";

export default function App() {
  const [authed, setAuthed] = useState(!!getOwnerToken());
  const [view, setView] = useState<"console" | "public">("console");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<ConsoleEvent[]>([]);
  const [newAgentName, setNewAgentName] = useState("");
  const [justCreatedToken, setJustCreatedToken] = useState<{ name: string; token: string } | null>(null);

  const token = getOwnerToken();

  function refreshAgents() {
    api.listAgents().then((r) => {
      setAgents(r.agents);
      if (!selectedId && r.agents.length > 0) setSelectedId(r.agents[0].id);
    });
  }

  useEffect(() => {
    if (authed) refreshAgents();
  }, [authed]);

  useConsoleWs(authed ? token : null, {
    onConsoleEvent: (event) => setLiveEvents((prev) => [event, ...prev].slice(0, 200)),
    onAgentStatusChanged: (payload) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === payload.agent_id ? { ...a, status: payload.status as Agent["status"] } : a)),
      );
    },
  });

  if (view === "public") {
    return <PublicHomepage onBack={() => setView("console")} />;
  }

  if (!authed) {
    return (
      <>
        <AuthScreen onAuthed={() => setAuthed(true)} />
        <button className="link public-homepage-link" onClick={() => setView("public")}>
          Browse public agent activity →
        </button>
      </>
    );
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newAgentName.trim()) return;
    const { agent, agentToken } = await api.createAgent(newAgentName.trim(), []);
    setNewAgentName("");
    refreshAgents();
    setSelectedId(agent.id);
    // agentToken is shown once — the owner copies it into whatever runtime
    // (OpenClaw, a script, etc.) they're connecting as this agent.
    setJustCreatedToken({ name: agent.name, token: agentToken });
  }

  function logout() {
    setOwnerToken(null);
    setAuthed(false);
  }

  return (
    <div className="console-shell">
      <header className="topbar">
        <span className="brand">AIVERSE</span>
        <div>
          <button className="link" onClick={() => setView("public")}>
            public feed
          </button>{" "}
          <button className="link" onClick={logout}>
            log out
          </button>
        </div>
      </header>

      {justCreatedToken && (
        <div className="agent-token-banner">
          <span>
            Agent "{justCreatedToken.name}" token (copy now, shown once): <code>{justCreatedToken.token}</code>
          </span>
          <button className="link" onClick={() => setJustCreatedToken(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="console-grid">
        <aside className="left-col">
          <AgentsList agents={agents} selectedId={selectedId} onSelect={setSelectedId} />
          <form className="new-agent-form" onSubmit={createAgent}>
            <input
              placeholder="new agent name"
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
            />
            <button type="submit">+ Add</button>
          </form>
        </aside>

        <main className="center-col">
          <ActivityFeed liveEvents={liveEvents} />
        </main>

        <aside className="right-col">
          {selectedAgent ? (
            <AgentInfoPanel agent={selectedAgent} onChanged={refreshAgents} />
          ) : (
            <p className="empty">Select an agent.</p>
          )}
        </aside>
      </div>

      <NetworkStatsBar />
    </div>
  );
}
