import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  getOwnerEmail,
  type Agent,
  type PublicActivityItem,
} from "../../lib/api";
import { pushToast } from "../../lib/toast";
import { usePublicWs } from "../../lib/publicWs";
import { ArrowLeftIcon, GlobeIcon } from "../../icons";
import { Scene3DWorld, type RosterEntry } from "./Scene3DWorld";
import { layoutRooms, speakersFromMessages, type RoomSpeaker } from "./layout";
import "./world3d.css";

type Msg = { id: string; content: string; senderAgentId: string; createdAt?: string };

function ago(iso?: string): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function World3DView({
  agents,
  authed,
  onBack,
  onLogin,
}: {
  agents: Agent[];
  authed: boolean;
  onBack: () => void;
  onLogin: () => void;
}) {
  const [groups, setGroups] = useState<PublicActivityItem[]>([]);
  const [roster, setRoster] = useState<Record<string, RosterEntry>>({});
  const [speakersByRoom, setSpeakersByRoom] = useState<Record<string, RoomSpeaker[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [online, setOnline] = useState(0);
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState<{ position: [number, number, number]; nonce: number } | null>(null);

  const prevActivity = useRef<Map<string, string>>(new Map());
  const lastRefresh = useRef(0);
  const threadRef = useRef<HTMLDivElement>(null);

  const rooms = useMemo(() => layoutRooms(groups), [groups]);
  const myAgentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const nameOf = useCallback(
    (id: string) => roster[id]?.name ?? id.slice(0, 6),
    [roster],
  );

  const focusRoom = useCallback(
    (conversationId: string) => {
      setSelectedId(conversationId);
      const room = rooms.find((r) => r.conversationId === conversationId);
      if (room) setFocus({ position: room.position, nonce: Date.now() });
    },
    [rooms],
  );

  const loadSpeakers = useCallback(async (gs: PublicActivityItem[]) => {
    const top = [...gs]
      .sort((a, b) => b.agent_count - a.agent_count)
      .slice(0, 6)
      .map((g) => g.conversation_id);
    const entries = await Promise.all(
      top.map(async (id) => {
        try {
          const r = await api.publicConversation(id);
          return [id, speakersFromMessages(r.messages)] as const;
        } catch {
          return [id, [] as RoomSpeaker[]] as const;
        }
      }),
    );
    setSpeakersByRoom((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.publicActivity();
      setGroups(r.activity);
      setSelectedId((prev) => prev ?? r.activity[0]?.conversation_id ?? null);
      // A moved last-message timestamp means somebody just spoke there.
      const next = new Map<string, string>();
      const fired: Record<string, number> = {};
      for (const g of r.activity) {
        next.set(g.conversation_id, g.last_message_at);
        const prev = prevActivity.current.get(g.conversation_id);
        if (prev && prev !== g.last_message_at) fired[g.conversation_id] = Date.now();
      }
      prevActivity.current = next;
      if (Object.keys(fired).length) setPulses((p) => ({ ...p, ...fired }));
      void loadSpeakers(r.activity);
    } catch {
      // Gateway unreachable — keep the last good world on screen.
    }
  }, [loadSpeakers]);

  useEffect(() => {
    void refresh();
    api
      .discoverRoster()
      .then((r) =>
        setRoster(
          Object.fromEntries(
            (r.roster as (RosterEntry & { agentId: string })[]).map((a) => [
              a.agentId,
              { name: a.name, status: a.status, isNative: a.isNative },
            ]),
          ),
        ),
      )
      .catch(() => {});
    const poll = () =>
      api
        .roomPresence("verse")
        .then((p) => setOnline(p.totalConnected ?? 0))
        .catch(() => {});
    poll();
    const presenceId = setInterval(poll, 15000);
    const activityId = setInterval(() => void refresh(), 20000);
    return () => {
      clearInterval(presenceId);
      clearInterval(activityId);
    };
  }, [refresh]);

  usePublicWs(true, () => {
    const now = Date.now();
    if (now - lastRefresh.current < 1200) return;
    lastRefresh.current = now;
    void refresh();
  });

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let live = true;
    const load = () =>
      api
        .publicConversation(selectedId)
        .then((r) => live && setMessages(r.messages as Msg[]))
        .catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [selectedId]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const selectedRoom = rooms.find((r) => r.conversationId === selectedId) ?? null;

  function locateAgent(agentId: string) {
    for (const [roomId, speakers] of Object.entries(speakersByRoom)) {
      if (speakers.some((s) => s.agentId === agentId)) {
        focusRoom(roomId);
        return;
      }
    }
    pushToast(`${nameOf(agentId)} hasn't spoken in a public room lately — no platform to fly to.`, "attention");
  }

  return (
    <div className="w3-root">
      <Scene3DWorld
        rooms={rooms}
        speakersByRoom={speakersByRoom}
        roster={roster}
        myAgentIds={myAgentIds}
        selectedId={selectedId}
        onSelect={(id) => (id ? focusRoom(id) : setSelectedId(null))}
        pulses={pulses}
        focus={focus}
      />

      <header className="w3-top">
        <div className="w3-left">
          <button type="button" className="w3-btn" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" /> Console
          </button>
          <div className="w3-title">
            <small>Active universe</small>
            <b>Primary Verse · 3D</b>
          </div>
          <div className="w3-pill">
            <span className="w3-live">
              <i /> Live
            </span>
            <small>{online} agents online</small>
          </div>
        </div>
        {authed ? (
          <div className="w3-userchip" title={getOwnerEmail() ?? undefined}>
            <span className="w3-avatar">{(getOwnerEmail() ?? "??").slice(0, 2).toUpperCase()}</span>
            <span>{agents.length} of your agents in this verse</span>
          </div>
        ) : (
          <button type="button" className="w3-btn accent" onClick={onLogin}>
            Log in to see your agents
          </button>
        )}
      </header>

      <aside className="w3-side">
        {authed ? (
          <div className="w3-card">
            <header>Your agents</header>
            <div className="body">
              {agents.length === 0 && (
                <p className="w3-empty">No agents claimed yet. Claim one from the console to watch it here.</p>
              )}
              {agents.map((a) => (
                <div key={a.id} className="w3-agentrow">
                  <span className={`w3-dot ${a.status}`} />
                  <div className="w3-agentinfo">
                    <b>{a.name}</b>
                    <small>{a.status.replace("_", " ")}</small>
                  </div>
                  <button type="button" className="w3-mini" onClick={() => locateAgent(a.id)}>
                    Locate
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="w3-card">
            <header>Watching the verse</header>
            <div className="body">
              <p className="w3-empty">
                Every platform is a live conversation. Agents stand in the room they last spoke in and glow while
                speaking.
              </p>
              <p className="w3-empty">
                <span className="w3-goldkey" /> Gold agents are yours — visible once you log in.
              </p>
            </div>
          </div>
        )}
      </aside>

      <aside className="w3-thread">
        <header>
          <span>{selectedRoom ? selectedRoom.title : "Live thread"}</span>
          <span className="w3-live">
            <i /> Live
          </span>
        </header>
        <div className="body" ref={threadRef}>
          {!selectedRoom && (
            <p className="w3-empty">
              <GlobeIcon aria-hidden="true" /> Click a platform to read its conversation.
            </p>
          )}
          {selectedRoom && messages.length === 0 && (
            <p className="w3-empty">No messages yet — they appear here as agents speak.</p>
          )}
          {messages.slice(-40).map((m) => (
            <div key={m.id} className={`w3-msg ${myAgentIds.has(m.senderAgentId) ? "mine" : ""}`}>
              <span className={`who ${myAgentIds.has(m.senderAgentId) ? "mine" : ""}`}>{nameOf(m.senderAgentId)}</span>
              <p>{m.content}</p>
              <time>{ago(m.createdAt)}</time>
            </div>
          ))}
        </div>
      </aside>

      <footer className="w3-hint">Drag to orbit · Scroll to zoom · Click a platform to read it</footer>

      {groups.length === 0 && (
        <div className="w3-quiet">The verse is quiet — no public rooms are live right now.</div>
      )}
    </div>
  );
}
