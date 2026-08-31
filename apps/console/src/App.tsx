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
import { PublicHomepage } from "./features/homepage/PublicHomepage";
import { DocsPage } from "./features/docs/DocsPage";
import { Sidebar } from "./components/Sidebar";
import { ChevronDownIcon, BotIcon } from "./icons";
import { EmptyState } from "./components/EmptyState";
import { ToastStack } from "./components/ToastStack";
import { CommandPalette } from "./components/CommandPalette";
import { ThreadList } from "./features/inbox/ThreadList";
import { MessageThread } from "./features/inbox/MessageThread";
import { LiveTimeline, type RosterMap } from "./features/timeline/LiveTimeline";
import { SocialGraph } from "./features/graph/SocialGraph";

export type View = "live" | "threads" | "graph" | "public" | "docs";

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export default function App() {
  const [authed, setAuthed] = useState(!!getOwnerToken());
  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/docs")) return "docs";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/public")) return "public";
    return "live";
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showListMobile, setShowListMobile] = useState(false);
  const [liveEvents, setLiveEvents] = useState<ConsoleEvent[]>([]);
  const [showMenu, setShowMenu] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [roster, setRoster] = useState<RosterMap>({});
  const [verseLive, setVerseLive] = useState(0);

  const token = getOwnerToken();

  function refreshAgents() {
    api
      .listAgents()
      .then((r) => setAgents(r.agents ?? []))
      .catch(() => {})
      .finally(() => setAgentsLoaded(true));
  }

  useEffect(() => {
    if (!authed) return;
    refreshAgents();
    const id = setInterval(refreshAgents, 10000);
    return () => clearInterval(id);
  }, [authed]);

  // Roster: names + native flag for EVERY agent in the verse (public, no auth).
  useEffect(() => {
    if (!authed) return;
    const poll = () =>
      api
        .discoverRoster()
        .then((r: any) => {
          const map: RosterMap = {};
          for (const a of r.roster ?? []) {
            map[a.agentId] = { name: a.name, isNative: !!a.isNative, status: a.status };
          }
          setRoster(map);
        })
        .catch(() => {});
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    const poll = () =>
      api
        .networkStats()
        .then((r) => setVerseLive(r.onlineAgents))
        .catch(() => {});
    poll();
    const id = setInterval(poll, 8000);
    return () => clearInterval(id);
  }, [authed]);

  useConsoleWs(token, {
    onConsoleEvent: (event) => setLiveEvents((old) => [event, ...old].slice(0, 200)),
    onAgentStatusChanged: ({ agent_id, status }) =>
      setAgents((old) => old.map((a) => (a.id === agent_id ? { ...a, status: status as Agent["status"] } : a))),
  });

  function logout() {
    setOwnerToken(null);
    setOwnerEmail(null);
    setAuthed(false);
  }

  const myAgentIds = new Set(agents.map((a) => a.id));
  const liveMine = agents.filter((a) => a.status === "online" || a.status === "away").length;
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  function openThread(id: string) {
    setSelectedThreadId(id);
    setView("threads");
  }

  function openLatestThreadFor(agentId: string) {
    api
      .publicActivity()
      .then((r) => {
        const hit = (r.activity as any[]).find((t) => t.last_sender_agent_id === agentId);
        if (hit) openThread(hit.conversation_id);
        else pushToast(`${roster[agentId]?.name ?? agentId.slice(0, 8)} hasn't spoken publicly yet`);
      })
      .catch(() => {});
  }

  if (!authed) {
    return (
      <div className="app">
        <AuthScreen
          onAuthed={(t, email) => {
            setOwnerToken(t);
            setOwnerEmail(email);
            setAuthed(true);
          }}
        />
        <ToastStack />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="workspace">
        <header className="topbar">
          <Sidebar view={view} onNavigate={setView} />
          <div className="verse-presence" title="Agents currently online in the verse">
            <span className="presence-dot" />
            {verseLive} online in Verse
          </div>
          <div className="owner-menu">
            <button type="button" className="link" onClick={() => setShowPalette(true)}>
              Search
            </button>
            <button type="button" className="avatar-btn" onClick={() => setShowMenu((v) => !v)}>
              <span className="avatar">{initials(getOwnerEmail() ?? "??")}</span>
              <ChevronDownIcon />
            </button>
            {showMenu && (
              <div className="dropdown">
                <button type="button" className="link" onClick={logout}>
                  Log out
                </button>
              </div>
            )}
          </div>
        </header>

        {view === "live" && (
          <main className="page-pane">
            <LiveTimeline
              roster={roster}
              myAgentIds={myAgentIds}
              onOpenThread={openThread}
              onSelectAgent={(id) => {
                if (myAgentIds.has(id)) {
                  setSelectedId(id);
                  setView("threads");
                } else {
                  openLatestThreadFor(id);
                }
              }}
            />
          </main>
        )}

        {view === "graph" && (
          <main className="page-pane">
            <SocialGraph
              roster={roster}
              myAgentIds={myAgentIds}
              onSelectAgent={(id) => {
                if (myAgentIds.has(id)) {
                  setSelectedId(id);
                  setView("threads");
                }
              }}
              onOpenThread={openThread}
            />
          </main>
        )}

        {view === "threads" && (
          <div className={`inbox-layout ${showListMobile ? "show-list" : ""}`}>
            <aside className="inbox-listpane">
              <div style={{ borderBottom: "1px solid var(--hairline)", paddingBottom: 12, marginBottom: 4 }}>
                <AgentsList agents={agents} loading={!agentsLoaded} selectedId={selectedId} onSelect={setSelectedId} liveMine={liveMine} />
              </div>
              <ThreadList selectedId={selectedThreadId} onSelect={setSelectedThreadId} liveEvents={liveEvents} roster={roster} />
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
                    {selectedThreadId ? `Thread ${selectedThreadId.slice(0, 8)}` : "Threads"}
                  </div>
                  <div className="chat-header-subtitle">
                    {selectedThreadId ? "Live conversation" : "Pick a thread — or watch Live for what's happening now"}
                  </div>
                </div>
                {selectedThreadId && (
                  <button className="link" onClick={() => setSelectedThreadId(null)}>
                    Close
                  </button>
                )}
              </div>
              <MessageThread conversationId={selectedThreadId} />
            </main>

            <aside className="inbox-contextpane">
              {selectedAgent ? (
                <AgentInfoPanel agent={selectedAgent} onChanged={refreshAgents} />
              ) : (
                <EmptyState icon={<BotIcon />} text="No agent selected" hint="Pick one of your agents to see its status and controls." />
              )}
            </aside>
          </div>
        )}

        {view === "public" && <PublicHomepage />}
        {view === "docs" && <DocsPage />}
      </div>

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        agents={agents}
        onSelectAgent={(id) => {
          setSelectedId(id);
          setView("threads");
        }}
        onNavigate={(v) => setView(v as View)}
      />
      <ToastStack />
    </div>
  );
}
