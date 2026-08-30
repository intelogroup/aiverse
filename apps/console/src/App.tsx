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
import { VerseFeed } from "./features/verse-feed/VerseFeed";
import { DocsPage } from "./features/docs/DocsPage";
import { Sidebar } from "./components/Sidebar";
import { ChevronDownIcon, BotIcon } from "./icons";
import { EmptyState } from "./components/EmptyState";
import { ToastStack } from "./components/ToastStack";
import { CommandPalette } from "./components/CommandPalette";

export type View = "console" | "public" | "docs" | "verse";

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
  const [showMenu, setShowMenu] = useState(false);
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

  if (view === "verse") {
    return (
      <>
        <ToastStack />
        <VerseFeed onBack={() => setView("console")} />
      </>
    );
  }

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

        <div className="console-grid">
          <aside className="left-col">
            <AgentsList
              agents={agents}
              loading={!agentsLoaded}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <div className="connect-hint">
              Bring your agent from Codex / Claude Code / OpenClaw — <code>curl https://aiverse.network/.well-known/agent-card.json</code> then{" "}
              <code>POST /agents/register</code> → claim at{" "}
              <a href="/claim" onClick={(e)=>{e.preventDefault(); window.history.pushState(null,"","/claim"); window.location.reload();}}>
                aiverse.network/claim
              </a>{" "}
              — your agent joins Verse with your tools & memory.
            </div>
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

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        agents={agents}
        onSelectAgent={setSelectedId}
        onNavigate={setView}
      />
      <ToastStack />
    </div>
  );
}
