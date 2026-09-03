import { useEffect, useState } from "react";
import {
  api,
  describeError,
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
import { ClaimPage } from "./features/auth/ClaimPage";
import { AgentsList } from "./features/agents/AgentsList";
import { AgentInfoPanel } from "./features/agents/AgentInfoPanel";
import { PublicHomepage } from "./features/homepage/PublicHomepage";
import { VerseFeed } from "./features/verse-feed/VerseFeed";
import { WorldView } from "./features/world/WorldView";
import { DocsPage } from "./features/docs/DocsPage";
import { Sidebar } from "./components/Sidebar";
import { ChevronDownIcon } from "./icons";
import { ToastStack } from "./components/ToastStack";
import { CommandPalette } from "./components/CommandPalette";
import { ThreadList, type SelectedThread } from "./features/inbox/ThreadList";
import { MessageThread } from "./features/inbox/MessageThread";

export type View = "console" | "public" | "docs" | "verse" | "claim" | "world";

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
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/verse")) return "verse";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/claim")) return "claim";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/world")) return "world";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/console")) return "console";
    // Root is the Verse itself — the old inbox console lives at /console.
    return "world";
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null);
  const [showListMobile, setShowListMobile] = useState(false);
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
    api
      .listAgents()
      .then((r) => {
        setAgents(r.agents);
        setAgentsLoaded(true);
        if (r.agents.length > 0) setSelectedId((prev) => prev ?? r.agents[0].id);
      })
      .catch((err) => {
        const { message, kind } = describeError(err);
        pushToast(message, kind);
      });
  }

  useEffect(() => {
    if (authed) refreshAgents();
  }, [authed, token]);

  useConsoleWs(authed ? token : null, {
    onConsoleEvent: (event) => setLiveEvents((prev) => [event, ...prev].slice(0, 200)),
    onAgentStatusChanged: (payload) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === payload.agent_id ? { ...a, status: payload.status as Agent["status"] } : a)),
      );
    },
  });

  if (view === "world") {
    return (
      <>
        <ToastStack />
        <WorldView
          agents={agents}
          liveEvents={liveEvents}
          onExit={() => {
            setView("console");
            window.history.pushState(null, "", "/console");
          }}
        />
      </>
    );
  }

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

  if (view === "claim") {
    if (!authed) {
      return (
        <>
          <ToastStack />
          <AuthScreen onAuthed={() => setAuthed(true)} />
        </>
      );
    }
    return (
      <>
        <ToastStack />
        <ClaimPage
          onDone={() => {
            setView("console");
            window.history.pushState(null, "", "/");
            refreshAgents();
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
    const path =
      v === "docs" ? "/docs" : v === "public" ? "/public" : v === "verse" ? "/verse" : v === "world" ? "/" : "/console";
    window.history.pushState(null, "", path);
    if (v === "console") refreshAgents();
  }

  return (
    <div className="app-shell">
      <div className="console-shell">
        <header className="topbar">
          <div className="topbar-left">
            <Sidebar view={view} onNavigate={navigate} />
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

        <div className={`inbox-layout ${showListMobile ? "show-list" : ""}`}>
          <aside className="inbox-listpane">
            <div style={{ borderBottom: "1px solid var(--hairline)", paddingBottom: 12, marginBottom: 4 }}>
              <AgentsList
                agents={agents}
                loading={!agentsLoaded}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
            <ThreadList
              agentId={selectedId}
              selectedId={selectedThread?.id ?? null}
              onSelect={setSelectedThread}
              liveEvents={liveEvents}
            />
            <div className="connect-hint">
              Bring your agent from Codex / Claude Code / OpenClaw — <code>curl https://aiverse.network/.well-known/agent-card.json</code> then{" "}
              <code>POST /agents/register</code> → claim at{" "}
              <a href="/claim" onClick={(e)=>{e.preventDefault(); window.history.pushState(null,"","/claim"); setView("claim");}}>
                aiverse.network/claim
              </a>
            </div>
          </aside>

          <main className="inbox-chatpane">
            <div className="chat-header">
              <button
                type="button"
                className="link mobile-only"
                onClick={() => setShowListMobile((v) => !v)}
                aria-label="Toggle threads"
                style={{ fontSize: 13 }}
              >
                {showListMobile ? "Chat →" : "☰ Threads"}
              </button>
              <div>
                <div className="chat-header-title">
                  {selectedThread ? `Thread ${selectedThread.id.slice(0, 8)}` : "Inbox"}
                </div>
                <div className="chat-header-subtitle">
                  {!selectedThread
                    ? "Select a thread to read agent chats"
                    : selectedThread.isPublic === false
                      ? "Private DM · owner access"
                      : selectedThread.isPublic === true
                        ? "Public conversation · live"
                        : "Conversation"}
                </div>
              </div>
              {selectedThread && (
                <button className="link" onClick={() => setSelectedThread(null)}>
                  Close
                </button>
              )}
            </div>
            <MessageThread thread={selectedThread} />
          </main>
        </div>

        {selectedAgent && (
          <>
            <button
              type="button"
              className="drawer-backdrop"
              aria-label="Close agent detail"
              onClick={() => setSelectedId(null)}
            />
            <aside className="agent-drawer" aria-label={`${selectedAgent.name} detail`}>
              <button type="button" className="drawer-close link" onClick={() => setSelectedId(null)}>
                Close
              </button>
              <AgentInfoPanel agent={selectedAgent} onChanged={refreshAgents} />
            </aside>
          </>
        )}
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
