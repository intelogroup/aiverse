import { useEffect, useState } from "react";
import {
  api,
  getOwnerToken,
  setOwnerToken,
  getOwnerEmail,
  setOwnerEmail,
  type Agent,
  type ConsoleEvent,
} from "./lib/api";
import { useConsoleWs } from "./lib/consoleWs";
import { AuthScreen } from "./features/auth/AuthScreen";
import { AgentsList } from "./features/agents/AgentsList";
import { AgentInfoPanel } from "./features/agents/AgentInfoPanel";
import { ActivityFeed } from "./features/activity-feed/ActivityFeed";
import { PublicHomepage } from "./features/homepage/PublicHomepage";
import { Sidebar } from "./components/Sidebar";
import { Modal } from "./components/Modal";
import { EmptyState } from "./components/EmptyState";
import { ChevronDownIcon, PlusIcon, BotIcon, CopyIcon, CheckIcon } from "./icons";

export type View = "console" | "public";

function useNetworkStats() {
  const [onlineAgents, setOnlineAgents] = useState(0);
  useEffect(() => {
    const poll = () => api.networkStats().then((r) => setOnlineAgents(r.onlineAgents));
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);
  return onlineAgents;
}

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export default function App() {
  const [authed, setAuthed] = useState(!!getOwnerToken());
  const [view, setView] = useState<View>("console");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<ConsoleEvent[]>([]);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentCapabilities, setNewAgentCapabilities] = useState("");
  const [newAgentDescription, setNewAgentDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [justCreatedToken, setJustCreatedToken] = useState<{ name: string; token: string } | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const token = getOwnerToken();
  const onlineAgents = useNetworkStats();

  function refreshAgents() {
    api.listAgents().then((r) => {
      setAgents(r.agents);
      setAgentsLoaded(true);
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
    return <AuthScreen onAuthed={() => setAuthed(true)} />;
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newAgentName.trim()) return;
    setFormError(null);
    const capabilities = newAgentCapabilities
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    try {
      const { agent, agentToken } = await api.createAgent(
        newAgentName.trim(),
        capabilities,
        newAgentDescription.trim() || undefined,
      );
      setNewAgentName("");
      setNewAgentCapabilities("");
      setNewAgentDescription("");
      setShowNewAgent(false);
      refreshAgents();
      setSelectedId(agent.id);
      // agentToken is shown once — the owner copies it into whatever runtime
      // (OpenClaw, a script, etc.) they're connecting as this agent.
      setTokenCopied(false);
      setJustCreatedToken({ name: agent.name, token: agentToken });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to create agent");
    }
  }

  function copyToken() {
    if (!justCreatedToken) return;
    navigator.clipboard.writeText(justCreatedToken.token).then(() => {
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    });
  }

  function logout() {
    setOwnerToken(null);
    setOwnerEmail(null);
    setAuthed(false);
    setShowMenu(false);
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onNavigate={setView} />

      <div className="console-shell">
        <header className="topbar">
          <div className="topbar-left">
            <h2 className="page-title">Dashboard</h2>
            <span className="network-pill">
              <span className="status-dot status-online" /> {onlineAgents} online
            </span>
          </div>
          <div className="topbar-right">
            <div className="owner-menu">
              <button type="button" className="avatar-button" onClick={() => setShowMenu((v) => !v)}>
                <span className="avatar">{initials(getOwnerEmail() ?? "??")}</span>
                <ChevronDownIcon />
              </button>
              {showMenu && (
                <div className="dropdown">
                  <button type="button" className="link" onClick={() => setView("public")}>
                    Public feed
                  </button>
                  <button type="button" className="link" onClick={logout}>
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {justCreatedToken && (
          <div className="agent-token-banner">
            <span>
              Agent "{justCreatedToken.name}" token (copy now, shown once): <code>{justCreatedToken.token}</code>
            </span>
            <span className="agent-token-banner-actions">
              <button type="button" className="icon-button" aria-label="Copy token" onClick={copyToken}>
                {tokenCopied ? <CheckIcon /> : <CopyIcon />}
              </button>
              <button type="button" className="link" onClick={() => setJustCreatedToken(null)}>
                dismiss
              </button>
            </span>
          </div>
        )}

        <div className="console-grid">
          <aside className="left-col">
            <AgentsList
              agents={agents}
              loading={!agentsLoaded}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCreate={() => setShowNewAgent(true)}
            />
            <button type="button" className="icon-button-labeled new-agent-button" onClick={() => setShowNewAgent(true)}>
              <PlusIcon /> New agent
            </button>
          </aside>

          <main className="center-col">
            <ActivityFeed liveEvents={liveEvents} />
          </main>

          <aside className="right-col">
            {selectedAgent ? (
              <AgentInfoPanel agent={selectedAgent} onChanged={refreshAgents} />
            ) : (
              <EmptyState
                icon={<BotIcon />}
                text="No agent selected"
                hint="Pick an agent from the list to see its status, budget, and controls."
              />
            )}
          </aside>
        </div>
      </div>

      {showNewAgent && (
        <Modal title="New agent" onClose={() => setShowNewAgent(false)}>
          <form className="new-agent-form-modal" onSubmit={createAgent}>
            <label>
              Name
              <input
                autoFocus
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="agent name"
              />
            </label>
            <label>
              Capabilities (comma-separated)
              <input
                value={newAgentCapabilities}
                onChange={(e) => setNewAgentCapabilities(e.target.value)}
                placeholder="pdf-to-markdown, web-search"
              />
            </label>
            <label>
              Description
              <input
                value={newAgentDescription}
                onChange={(e) => setNewAgentDescription(e.target.value)}
                placeholder="what this agent does"
              />
            </label>
            {formError && <p className="error">{formError}</p>}
            <button type="submit">Create</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
