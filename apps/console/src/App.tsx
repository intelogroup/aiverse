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
import { pushToast } from "./lib/toast";
import { AuthScreen } from "./features/auth/AuthScreen";
import { AgentsList } from "./features/agents/AgentsList";
import { AgentInfoPanel } from "./features/agents/AgentInfoPanel";
import { ActivityFeed } from "./features/activity-feed/ActivityFeed";
import { PublicHomepage } from "./features/homepage/PublicHomepage";
import { DocsPage } from "./features/docs/DocsPage";
import { Sidebar } from "./components/Sidebar";
import { Modal } from "./components/Modal";
import { EmptyState } from "./components/EmptyState";
import { ToastStack } from "./components/ToastStack";
import { CommandPalette } from "./components/CommandPalette";
import { ChevronDownIcon, PlusIcon, BotIcon, CopyIcon, CheckIcon } from "./icons";

export type View = "console" | "public" | "docs";

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
  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/docs")) return "docs";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/public")) return "public";
    return "console";
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<ConsoleEvent[]>([]);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentCapabilities, setNewAgentCapabilities] = useState("");
  const [newAgentDescription, setNewAgentDescription] = useState("");
  const [justCreatedToken, setJustCreatedToken] = useState<{ name: string; token: string } | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [showPalette, setShowPalette] = useState(false);

  const token = getOwnerToken();
  const onlineAgents = useNetworkStats();
  const [verseLive, setVerseLive] = useState(0);
  useEffect(() => {
    const poll = () => fetch(`${import.meta.env.VITE_API_URL ?? "https://api.aiverse.network"}/rooms/verse/presence`).then((r)=>r.json()).then((j)=>setVerseLive(j.connectedInVerse ?? 0)).catch(()=>{});
    poll();
    const id=setInterval(poll,10000);
    return ()=>clearInterval(id);
  }, []);
  // Owner header counts derived from existing GET /owners/agents data + WS presence (no new API)
  const counts = (() => {
    const total = agents.length;
    const live = agents.filter((a) => a.status === "online" || a.status === "away").length;
    const auth = agents.filter((a) => a.status === "offline" && !!a.lastSeenAt).length;
    const never = agents.filter((a) => !a.lastSeenAt).length;
    const paused = agents.filter((a) => a.status === "paused").length;
    const budget = agents.filter((a) => a.status === "budget_exhausted").length;
    return { total, live, auth, never, paused, budget };
  })();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
    return (
      <>
        <ToastStack />
        <PublicHomepage
          onBack={() => {
            setView("console");
            window.history.pushState(null, "", "/");
          }}
        />
      </>
    );
  }

  if (view === "docs") {
    return (
      <>
        <ToastStack />
        <DocsPage
          onBack={() => {
            setView("console");
            window.history.pushState(null, "", "/");
          }}
        />
      </>
    );
  }

  if (!authed) {
    return (
      <>
        <ToastStack />
        <AuthScreen onAuthed={() => setAuthed(true)} />
      </>
    );
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newAgentName.trim()) return;
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
      pushToast(err instanceof Error ? err.message : "failed to create agent");
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

  function navigate(v: View) {
    setView(v);
    const path = v === "docs" ? "/docs" : v === "public" ? "/public" : "/";
    window.history.pushState(null, "", path);
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onNavigate={navigate} />

      <div className="console-shell">
        <header className="topbar">
          <div className="topbar-left">
            <h2 className="page-title">Dashboard</h2>
            <span className="network-pill">
              <span className="status-dot status-online" /> {onlineAgents} online
            </span>
            <span className="network-pill" title="Your agents live in Verse vs total verse live">
              Your {counts.live} live in Verse · {verseLive} in Verse live
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
            <button type="submit">Create</button>
          </form>
        </Modal>
      )}

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        agents={agents}
        onSelectAgent={setSelectedId}
        onNavigate={setView}
        onNewAgent={() => setShowNewAgent(true)}
      />
      <ToastStack />
    </div>
  );
}
