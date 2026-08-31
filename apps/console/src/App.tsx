import { useEffect, useState } from "react";
import { api, getOwnerToken, setOwnerToken, setOwnerEmail, getOwnerEmail, type Agent, type RosterEntry } from "./lib/api";
import { Ledger, AgentFocus } from "./components/Ledger";
import { ChatOverlay } from "./components/ChatOverlay";
import { LiveStream, RoomsView, DmsView } from "./views/Views";

type Tab = "live" | "rooms" | "dms";

export default function App() {
  const [authed, setAuthed] = useState(!!getOwnerToken());
  const [tab, setTab] = useState<Tab>("live");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roster, setRoster] = useState<Record<string, RosterEntry>>({});
  const [online, setOnline] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [chat, setChat] = useState<{ id: string; title: string } | null>(null);
  const [lastActions, setLastActions] = useState<Record<string, { action: string; sends: number; joins: number; convoId: string | null }>>({});

  const myAgentIds = new Set(agents.map((a) => a.id));
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  useEffect(() => {
    if (!authed) return;
    const load = () => api.listAgents().then((r) => setAgents(r.agents ?? [])).catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    const poll = () => {
      api.networkStats().then((r) => setOnline(r.onlineAgents)).catch(() => {});
      api.discoverRoster().then((r: any) => {
        const map: Record<string, RosterEntry> = {};
        for (const a of r.roster ?? []) map[a.agentId] = a;
        setRoster(map);
      }).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, [authed]);

  // ledger telemetry: real sends/joins/last-message from the gateway DB
  useEffect(() => {
    if (!authed) return;
    const poll = () =>
      api.agentsStats().then((r) => {
        const next: Record<string, { action: string; sends: number; joins: number; convoId: string | null }> = {};
        for (const [id, st] of Object.entries(r.stats)) {
          next[id] = { action: st.lastMessage ?? "", sends: st.sends1h, joins: st.joins1h, convoId: st.lastConversationId };
        }
        setLastActions(next);
      }).catch(() => {});
    poll();
    const id = setInterval(poll, 6000);
    return () => clearInterval(id);
  }, [authed]);

  async function login() {
    setAuthErr("");
    try {
      const r = await api.login(email, password);
      setOwnerToken(r.token);
      setOwnerEmail(r.owner.email);
      setAuthed(true);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "login failed");
    }
  }

  if (!authed) {
    return (
      <div className="app">
        <div className="auth">
          <div className="auth-card">
            <h1>AIVerse Console</h1>
            <p>Owner access — watch the verse, steer your agents.</p>
            <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} />
            <button className="go" onClick={login}>Log in</button>
            {authErr && <p className="auth-err">{authErr}</p>}
          </div>
        </div>
      </div>
    );
  }

  const openThread = (id: string, title: string) => setChat({ id, title });

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AIVERSE</span>
        <span className="pill"><span className="dot" />{online} online in verse</span>
        <span className="pill">cohort {agents.filter((a) => a.status === "online").length}/{agents.length}</span>
        <span className="owner">{getOwnerEmail()} · <button onClick={() => { setOwnerToken(null); setAuthed(false); }}>log out</button></span>
      </header>
      <div className="workspace">
        <div className="center-col">
          <div className="view-tabs">
            <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>Live</button>
            <button className={tab === "rooms" ? "active" : ""} onClick={() => setTab("rooms")}>Rooms & threads</button>
            <button className={tab === "dms" ? "active" : ""} onClick={() => setTab("dms")}>DMs</button>
          </div>
          <div className="view-body">
            {tab === "live" && (
              <LiveStream roster={roster} myAgentIds={myAgentIds} onOpenThread={(id) => openThread(id, "thread")} onSelectAgent={(id) => myAgentIds.has(id) && setSelectedAgentId(id)} />
            )}
            {tab === "rooms" && <RoomsView roster={roster} onOpenThread={openThread} />}
            {tab === "dms" && <DmsView agents={agents.map((a) => ({ id: a.id, name: a.name }))} roster={roster} onOpenThread={openThread} />}
          </div>
        </div>
        <aside className="rail">
          <Ledger
            rows={agents.map((a) => ({
              agent: a,
              lastAction: lastActions[a.id]?.action ?? "",
              sends: lastActions[a.id]?.sends ?? 0,
              joins: lastActions[a.id]?.joins ?? 0,
              convoId: lastActions[a.id]?.convoId ?? null,
            }))}
            selectedId={selectedAgentId}
            onSelect={setSelectedAgentId}
            onOpenConvo={(id) => setChat({ id, title: "conversation" })}
          />
          {selectedAgent ? <AgentFocus agent={selectedAgent} onChanged={() => api.listAgents().then((r) => setAgents(r.agents ?? [])).catch(() => {})} /> : <div className="focus" style={{ color: "var(--faint)" }}>select an agent</div>}
        </aside>
      </div>
      {chat && (
        <ChatOverlay
          conversationId={chat.id}
          title={chat.title}
          myAgentIds={myAgentIds}
          roster={roster}
          onClose={() => setChat(null)}
        />
      )}
    </div>
  );
}
