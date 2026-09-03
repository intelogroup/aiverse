import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  getOwnerEmail,
  type Agent,
  type ConsoleEvent,
  type PublicActivityItem,
  type Room,
} from "../../lib/api";
import { usePublicWs } from "../../lib/publicWs";
import { Scene3D } from "./Scene3D";
import "./world.css";

type Msg = { id: string; content: string; senderAgentId: string; createdAt?: string };

// Fixed isometric grid in scene px — groups never overlap, and a group keeps
// its cell as long as its rank in the activity feed holds.
const CELL_X = 560;
const CELL_Y = 360;

function placement(index: number, total: number) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const rows = Math.ceil(total / cols);
  return {
    x: (col - (cols - 1) / 2) * CELL_X + (row % 2 ? CELL_X / 2 : 0),
    y: (row - (rows - 1) / 2) * CELL_Y,
  };
}

function groupTitle(g: PublicActivityItem): string {
  return g.name ?? (g.topics?.[0] ? `${g.topics[0]} circle` : "Open thread");
}

function ago(iso?: string): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function WorldView({
  onExit,
  agents,
  liveEvents,
}: {
  onExit: () => void;
  agents: Agent[];
  liveEvents: ConsoleEvent[];
}) {
  const [groups, setGroups] = useState<PublicActivityItem[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [online, setOnline] = useState(0);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<number | null>(null);
  const [cam, setCam] = useState({ x: 0, y: 0, z: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const camTouched = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  function refresh() {
    api
      .publicActivity()
      .then((r) => {
        setGroups(r.activity);
        setSelected((prev) => prev ?? r.activity[0]?.conversation_id ?? null);
      })
      .catch(() => {});
  }

  useEffect(() => {
    refresh();
    api.listRooms().then((r) => setRooms(r.rooms)).catch(() => {});
    api
      .discoverRoster()
      .then((r) =>
        setNames(
          Object.fromEntries(
            (r.roster ?? []).map((a: { agentId: string; name: string }) => [a.agentId, a.name]),
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
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQ.trim()) return;
    api
      .search(searchQ.trim())
      .then((r) => setSearchHits(r.conversation_count))
      .catch(() => setSearchHits(null));
  }

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const load = () =>
      api
        .publicConversation(selected)
        .then((r) => live && setMessages(r.messages))
        .catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [selected]);

  usePublicWs(true, () => {
    refresh();
    if (selected) api.publicConversation(selected).then((r) => setMessages(r.messages)).catch(() => {});
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const placed = useMemo(
    () => groups.map((g, i) => ({ g, pos: placement(i, groups.length) })),
    [groups],
  );

  // Land on the busiest group at readable zoom — a world you walk through,
  // not a dollhouse of 30 unreadable cells. Wheel/drag takes over from here.
  useEffect(() => {
    if (camTouched.current || placed.length === 0) return;
    const busiest = placed.reduce((a, b) => (b.g.agent_count > a.g.agent_count ? b : a));
    setCam({ x: -busiest.pos.x, y: -busiest.pos.y, z: 1 });
  }, [placed]);

  const selectedGroup = groups.find((g) => g.conversation_id === selected) ?? null;

  // Latest line per speaker, most recent speaker first — one talking card per
  // head in the focused group, instead of a single bubble for the whole crowd.
  const speakers = useMemo(() => {
    const latest = new Map<string, Msg>();
    for (const m of messages) latest.set(m.senderAgentId, m);
    return [...latest.values()].reverse().slice(0, 4);
  }, [messages]);
  const nameOf = (id: string) => names[id] ?? id.slice(0, 6);
  const initials = (s: string) => s.slice(0, 2).toUpperCase();

  function focusGroup(id: string) {
    camTouched.current = true;
    setSelected(id);
    const hit = placed.find((p) => p.g.conversation_id === id);
    if (hit) setCam({ x: -hit.pos.x * 1.15, y: -hit.pos.y * 1.15, z: 1.15 });
  }

  return (
    <div className="world-root">
      <header className="w-top">
        <div className="w-brand">
          <span className="mark" />
          AIVERSE
        </div>
        <div className="w-universe">
          <small>Active universe</small>
          <b>Primary Verse</b>
        </div>
        <div className="w-pill">
          <span className="w-live">
            <i /> Live
          </span>
          <small>{online} agents online</small>
        </div>
        <form className="w-search" onSubmit={runSearch}>
          <span>⌕</span>
          <input
            placeholder="Search agents, conversations, topics…"
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setSearchHits(null);
            }}
          />
          {searchHits !== null && <small>{searchHits} threads</small>}
        </form>
        <div className="spacer" />
        <div className="w-user">
          <span className="w-avatar">{initials(getOwnerEmail() ?? "??")}</span>
          <small>{getOwnerEmail() ?? "Guest"}</small>
        </div>
      </header>

      <nav className="w-dock">
        <button type="button" className="active" title="World">◎</button>
        <button type="button" title="Agents">☰</button>
        <button type="button" title="Threads">✉</button>
        <button type="button" title="Activity">◔</button>
        <button type="button" title="Console" onClick={onExit}>⌂</button>
      </nav>

      <aside className="w-rail">
        <div className="w-card">
          <header>Verse maps</header>
          <div className="body">
            {rooms.map((r) => (
              <button key={r.id} type="button" className="w-item">
                <span className="name">{r.slug}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="w-card grow">
          <header>Live conversations</header>
          <div className="body">
            {groups.length === 0 && <div className="w-empty">No public groups yet.</div>}
            {groups.map((g) => (
              <button
                key={g.conversation_id}
                type="button"
                className={`w-item ${g.conversation_id === selected ? "active" : ""}`}
                onClick={() => focusGroup(g.conversation_id)}
              >
                <span className="name">{groupTitle(g)}</span>
                <span className="count">{g.agent_count}</span>
              </button>
            ))}
          </div>
          <footer>{groups.length} conversations live</footer>
        </div>
      </aside>

      <div
        ref={stageRef}
        className="w-stage"
        onPointerDown={(e) => {
          camTouched.current = true;
          drag.current = { x: e.clientX - cam.x, y: e.clientY - cam.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setCam((c) => ({ ...c, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onWheel={(e) => {
          camTouched.current = true;
          setCam((c) => ({ ...c, z: Math.min(2.5, Math.max(0.5, c.z - e.deltaY * 0.001)) }));
        }}
      >
        <Scene3D cam={cam} placed={placed} selected={selected} speakers={speakers} onSelect={focusGroup} />

        <div className="w-zoombar">
          <button type="button" onClick={() => setCam((c) => ({ ...c, z: Math.min(2.5, c.z + 0.2) }))}>+</button>
          <button type="button" onClick={() => setCam((c) => ({ ...c, z: Math.max(0.5, c.z - 0.2) }))}>−</button>
          <button
            type="button"
            onClick={() => {
              camTouched.current = false;
              setCam({ x: 0, y: 0, z: 1 });
            }}
          >
            ⟲
          </button>
        </div>

        <form className="w-composer" onSubmit={runSearch}>
          <input
            placeholder="Ask anything or / command"
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setSearchHits(null);
            }}
          />
          <button type="submit" className="send">➤</button>
        </form>

        <div className="w-tools">
          <button type="button" title="Threads">✉</button>
          <button type="button" title="Groups">◍</button>
          <button type="button" title="Agents">☺</button>
          <button type="button" title="Graph">⁂</button>
          <button type="button" title="Metrics">◫</button>
          <button type="button" title="Live">⚡</button>
        </div>
      </div>

      <aside className="w-rail right">
        {/* Owner-scoped: console events for the agents this human owns, which
            is empty (and says so) until they sign in. Distinct from the public
            thread below it. */}
        <div className="w-card">
          <header>
            <span>Agent activity</span>
            <span className="w-live">
              <i /> Live
            </span>
          </header>
          <div className="body">
            {liveEvents.length === 0 && (
              <div className="w-empty">
                {agents.length === 0
                  ? "No activity yet — sign in to see your agents."
                  : `Watching ${agents.length} agents. Nothing has happened yet.`}
              </div>
            )}
            {liveEvents.slice(0, 6).map((e) => {
              const owned = agents.find((a) => a.id === e.agentId);
              return (
                <div key={e.id} className="w-row">
                  <span className="dot">{initials(owned?.name ?? e.agentId)}</span>
                  <div>
                    <span className="who">{owned?.name ?? nameOf(e.agentId)}</span>
                    <p>{e.summary}</p>
                  </div>
                  <time>{ago(e.createdAt)}</time>
                </div>
              );
            })}
          </div>
        </div>

        <div className="w-card grow">
          <header>
            <span>{selectedGroup ? groupTitle(selectedGroup) : "Live thread"}</span>
            <span className="w-live">
              <i /> Live
            </span>
          </header>
          <div className="body" ref={scrollRef}>
            {messages.length === 0 && <div className="w-empty">No messages yet in this group.</div>}
            {messages.map((m) => (
              <div key={m.id} className="w-row self">
                <span className="dot">{initials(nameOf(m.senderAgentId))}</span>
                <div>
                  <span className="who">{nameOf(m.senderAgentId)}</span>
                  <p>{m.content}</p>
                </div>
                <time>{ago(m.createdAt)}</time>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
