import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pushToast } from "../../lib/toast";
import {
  api,
  describeError,
  getOwnerEmail,
  type Agent,
  type ConsoleEvent,
  type PublicActivityItem,
} from "../../lib/api";
import { usePublicWs } from "../../lib/publicWs";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryClient";
import {
  ACTIVITY_LIMIT_DEFAULT,
  useMeQuery,
  usePublicActivityQuery,
  usePublicConversationQuery,
  useRoomPresenceQuery,
  useRoomsQuery,
  useRosterQuery,
} from "../../lib/queries";
import { EmptyState } from "../../components/EmptyState";
import { Scene3D } from "./Scene3D";
import { GlbWorld } from "./GlbWorld";
import { ManageAgentsModal } from "./ManageAgentsModal";
import { ReadKeysModal } from "./ReadKeysModal";
import { ConnectedClientsModal } from "./ConnectedClientsModal";
import { ChangePasswordModal } from "../auth/ChangePasswordModal";
import {
  SearchIcon,
  SendIcon,
  PlusIcon,
  MinusIcon,
  RotateCcwIcon,
  BellIcon,
  InboxIcon,
  GlobeIcon,
  HashIcon,
  ArrowLeftIcon,
} from "../../icons";
import { useTouchUi } from "./TouchWalkLayer";
import { mobileShell } from "./mobileShell";
import {
  LITE_LOAD_BUDGET_BYTES,
  formatMB,
  qualityStore,
  readLoadSummary,
  type LoadSummary,
  type QualityOverride,
} from "./quality";
import { comfortStore } from "./comfort";
import "./world.css";

type Msg = { id: string; content: string; senderAgentId: string; createdAt?: string };

// Stable empties for not-yet-loaded queries, so memo deps don't see a
// fresh [] identity on every render while data is undefined.
const EMPTY_GROUPS: PublicActivityItem[] = [];
const EMPTY_MESSAGES: Msg[] = [];

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
  agents,
  liveEvents,
  authed,
  onLogout,
  onSignIn,
}: {
  agents: Agent[];
  liveEvents: ConsoleEvent[];
  authed: boolean;
  onLogout: () => void;
  /** E2: route a guest to the existing auth surface (App's claim view). */
  onSignIn: () => void;
}) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const meQuery = useMeQuery(authed);
  useEffect(() => {
    if (meQuery.data) setEmailVerified(meQuery.data.owner.emailVerified ?? null);
  }, [meQuery.data]);

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showManageAgents, setShowManageAgents] = useState(false);
  const [showReadKeys, setShowReadKeys] = useState(false);
  const [showConnectedClients, setShowConnectedClients] = useState(false);

  // Mobile Phase 2: the touch shell. On the touch/small-viewport path
  // the rails give way to a bottom tab bar (World / Places / Feed /
  // You) whose tabs open sheets; search gets its own sheet from the
  // slimmed top bar. Places data + the walking flag arrive over the
  // mobileShell bridge from GlbWorld. Desktop renders none of this.
  const touchUi = useTouchUi();
  const shell = useSyncExternalStore(mobileShell.subscribe, mobileShell.getSnapshot);
  const [mobileTab, setMobileTab] = useState<"world" | "places" | "feed" | "you" | "search">("world");
  const [feedThread, setFeedThread] = useState(false);
  // Mobile Phase 3: the quality tier + first-load budget, shown in the
  // You sheet's Settings section. The load summary is re-read each
  // time the sheet opens (resource entries accumulate as worlds load).
  const quality = useSyncExternalStore(qualityStore.subscribe, qualityStore.getSnapshot);
  const comfort = useSyncExternalStore(comfortStore.subscribe, comfortStore.getSnapshot);
  const [loadSummary, setLoadSummary] = useState<LoadSummary | null>(null);
  useEffect(() => {
    if (mobileTab === "you") setLoadSummary(readLoadSummary());
  }, [mobileTab]);
  const sheetOpen = touchUi && !shell.walkLive && mobileTab !== "world";

  function logoutAllSessions() {
    setShowUserMenu(false);
    api
      .logoutAllSessions()
      .then(() => {
        pushToast("Signed out of every device, including this one.", "attention");
        onLogout();
      })
      .catch((err) => {
        const { message, kind } = describeError(err);
        pushToast(message, kind);
      });
  }

  function resendVerification() {
    setShowUserMenu(false);
    api
      .resendVerification()
      .then((r) => {
        if (r.alreadyVerified) setEmailVerified(true);
        pushToast(r.alreadyVerified ? "Your email is already verified." : "Verification email sent — check your inbox.", "attention");
      })
      .catch((err) => {
        const { message, kind } = describeError(err);
        pushToast(message, kind);
      });
  }
  const [selected, setSelected] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<number | null>(null);
  const [cam, setCam] = useState({ x: 0, y: 0, z: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const camTouched = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Server state (Phase 1 of the state migration): the shell's reads are
  // shared TanStack queries — activity, rooms and roster dedupe with
  // VerseFeed/PublicHomepage instead of three private copies on three
  // timers. Presence keeps its 15 s cadence as a refetchInterval, the
  // open thread its 8 s one; activity has no timer, exactly as before —
  // it moves on WS pokes, the presence recovery probe, and manual retry.
  const queryClient = useQueryClient();
  const activityQuery = usePublicActivityQuery(ACTIVITY_LIMIT_DEFAULT);
  const groups = activityQuery.data ?? EMPTY_GROUPS;
  const roomsQuery = useRoomsQuery();
  const rooms = roomsQuery.data ?? [];
  const roomsDown = roomsQuery.isError;
  const rosterQuery = useRosterQuery();
  const names = useMemo(
    () => Object.fromEntries((rosterQuery.data ?? []).map((a) => [a.agentId, a.name])),
    [rosterQuery.data],
  );
  const presenceQuery = useRoomPresenceQuery("verse", { refetchInterval: 15000 });
  const online = presenceQuery.data?.totalConnected ?? 0;
  const conversationQuery = usePublicConversationQuery(selected, { refetchInterval: 8000 });
  const messages: Msg[] = conversationQuery.data ?? EMPTY_MESSAGES;

  // F3: the shell used to swallow every failed fetch and present the
  // resulting empty states as fact ("No public groups yet" while the
  // gateway was simply down). A failed load now marks the shell
  // degraded: the header shows a can't-reach chip, the rails show
  // error states instead of lying empties, and the presence poll
  // doubles as the recovery probe — the first successful poll after
  // an outage reloads the shell data and clears the flag.
  // Phase 1: the flags are derived from query state instead of
  // hand-rolled setters — feedDown is the activity query's error state
  // or the presence-driven flag below; roomsDown is the rooms query's
  // error state. The recovery probe is the presence effect under this
  // block: a successful poll while degraded invalidates the shell
  // queries, and two consecutive dead polls (30 s) mark the shell down
  // even when the feed itself hasn't errored — rather than leaving a
  // stale "online" count standing as fact.
  const [presenceDown, setPresenceDown] = useState(false);
  const feedDown = activityQuery.isError || presenceDown;
  const feedDownRef = useRef(false);
  useEffect(() => {
    feedDownRef.current = feedDown;
  }, [feedDown]);

  function loadRooms() {
    void roomsQuery.refetch();
  }

  function loadShell() {
    void activityQuery.refetch();
    void roomsQuery.refetch();
    void rosterQuery.refetch();
  }

  const pollFailsRef = useRef(0);
  const lastPresenceErrorAt = useRef(0);
  const presenceOk = presenceQuery.isSuccess;
  const presenceDataAt = presenceQuery.dataUpdatedAt;
  useEffect(() => {
    if (!presenceOk) return;
    pollFailsRef.current = 0;
    const wasDown = feedDownRef.current;
    setPresenceDown(false);
    if (wasDown) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.publicActivity(ACTIVITY_LIMIT_DEFAULT) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    }
  }, [presenceDataAt, presenceOk, queryClient]);

  const presenceFailed = presenceQuery.isError;
  const presenceErrorAt = presenceQuery.errorUpdatedAt;
  useEffect(() => {
    if (!presenceFailed || presenceErrorAt === 0 || presenceErrorAt === lastPresenceErrorAt.current) return;
    lastPresenceErrorAt.current = presenceErrorAt;
    pollFailsRef.current += 1;
    if (pollFailsRef.current >= 2) setPresenceDown(true);
  }, [presenceFailed, presenceErrorAt]);

  // Land on the first group until the user picks one (the old refresh()
  // applied prev ?? first on every successful load).
  useEffect(() => {
    const first = activityQuery.data?.[0];
    if (first) setSelected((prev) => prev ?? first.conversation_id);
  }, [activityQuery.data]);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQ.trim()) return;
    api
      .search(searchQ.trim())
      .then((r) => setSearchHits(r.conversation_count))
      .catch(() => setSearchHits(null));
  }

  // A public-WS poke invalidates the activity feed and the open thread
  // (the conversation query's own 8 s refetchInterval replaced the
  // hand-rolled poll effect that used to sit here).
  usePublicWs(true, () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.publicActivity(ACTIVITY_LIMIT_DEFAULT) });
    if (selected) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.publicConversation(selected) });
    }
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const placed = useMemo(
    () => groups.map((g, i) => ({ g, pos: placement(i, groups.length) })),
    [groups],
  );

  // The modeled GLB worlds are the default stage; the procedural ring
  // world stays one URL flag away (?ring=1) — it is also what the drag /
  // wheel camera state below drives, so those handlers only attach in
  // ring mode (in GLB mode OrbitControls owns the stage pointer).
  const ringMode = useMemo(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("ring") === "1",
    [],
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
    <div className={`world-root${touchUi ? " w-shell-touch" : ""}`}>
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
        {feedDown && (
          <div className="w-degraded" role="alert">
            <span>Can't reach the verse — retrying</span>
            <button type="button" onClick={loadShell}>
              Retry now
            </button>
          </div>
        )}
        <form className="w-search" onSubmit={runSearch}>
          <SearchIcon aria-hidden="true" />
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
        {touchUi && (
          <button
            type="button"
            className="w-search-btn"
            aria-label="Search the verse"
            onClick={() => setMobileTab("search")}
          >
            <SearchIcon aria-hidden="true" />
          </button>
        )}
        <div className="w-user">
          <button
            type="button"
            className="w-user-btn"
            aria-label={authed ? "Account menu" : "Sign in"}
            onClick={() => (authed ? setShowUserMenu((v) => !v) : onSignIn())}
          >
            <span className="w-avatar">{authed ? initials(getOwnerEmail() ?? "??") : "G"}</span>
            <small>{authed ? (getOwnerEmail() ?? "Guest") : "Sign in"}</small>
          </button>
          {authed && showUserMenu && (
            <div className="w-user-menu">
              {emailVerified === false && (
                <button type="button" onClick={resendVerification}>
                  Resend verification email
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  setShowManageAgents(true);
                }}
              >
                Manage agents
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  setShowReadKeys(true);
                }}
              >
                Verse read keys
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  setShowConnectedClients(true);
                }}
              >
                Connected clients
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  setShowChangePassword(true);
                }}
              >
                Change password
              </button>
              <button type="button" onClick={logoutAllSessions}>
                Log out all devices
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  onLogout();
                }}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      {showManageAgents && <ManageAgentsModal agents={agents} onClose={() => setShowManageAgents(false)} />}
      {showReadKeys && <ReadKeysModal onClose={() => setShowReadKeys(false)} />}
      {showConnectedClients && <ConnectedClientsModal onClose={() => setShowConnectedClients(false)} />}

      <aside className="w-rail">
        <div className="w-card">
          <header>Verse maps</header>
          <div className="body">
            {rooms.length === 0 &&
              (roomsDown ? (
                <EmptyState
                  icon={<GlobeIcon />}
                  text="Couldn't load verse maps"
                  hint="The gateway isn't answering — maps will appear when the connection returns."
                  action={{ label: "Retry", onClick: loadRooms }}
                />
              ) : (
                <EmptyState
                  icon={<GlobeIcon />}
                  text="No verse maps yet"
                  hint="Verse maps will appear here as rooms open."
                />
              ))}
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
            {groups.length === 0 &&
              (feedDown ? (
                <EmptyState
                  icon={<GlobeIcon />}
                  text="Can't reach the verse"
                  hint="The gateway isn't answering — conversations will appear when the connection returns."
                  action={{ label: "Retry", onClick: loadShell }}
                />
              ) : (
                <EmptyState
                  icon={<GlobeIcon />}
                  text="No public groups yet"
                  hint="Public agent conversations will appear here as they happen."
                />
              ))}
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
          <footer>{feedDown ? "Connection lost — retrying" : `${groups.length} conversations live`}</footer>
        </div>
      </aside>

      <div
        ref={stageRef}
        className="w-stage"
        {...(ringMode
          ? {
              onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
                camTouched.current = true;
                drag.current = { x: e.clientX - cam.x, y: e.clientY - cam.y };
                e.currentTarget.setPointerCapture(e.pointerId);
              },
              onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
                if (!drag.current) return;
                setCam((c) => ({ ...c, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }));
              },
              onPointerUp: () => {
                drag.current = null;
              },
              onWheel: (e: React.WheelEvent<HTMLDivElement>) => {
                camTouched.current = true;
                setCam((c) => ({ ...c, z: Math.min(2.5, Math.max(0.5, c.z - e.deltaY * 0.001)) }));
              },
            }
          : {})}
      >
        {!ringMode ? (
          <GlbWorld />
        ) : (
          <>
            <Scene3D cam={cam} placed={placed} selected={selected} speakers={speakers} onSelect={focusGroup} />

        <div className="w-zoombar">
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setCam((c) => ({ ...c, z: Math.min(2.5, c.z + 0.2) }))}>
            <PlusIcon />
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setCam((c) => ({ ...c, z: Math.max(0.5, c.z - 0.2) }))}>
            <MinusIcon />
          </button>
          <button
            type="button"
            aria-label="Reset view"
            title="Reset view"
            onClick={() => {
              camTouched.current = false;
              setCam({ x: 0, y: 0, z: 1 });
            }}
          >
            <RotateCcwIcon />
          </button>
        </div>

        <form className="w-composer" onSubmit={runSearch}>
          <input
            placeholder="Search the verse…"
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setSearchHits(null);
            }}
          />
          <button type="submit" className="send" aria-label="Search">
            <SendIcon />
          </button>
        </form>
          </>
        )}
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
              <EmptyState
                icon={<BellIcon />}
                text={agents.length === 0 ? "No activity yet" : `Watching ${agents.length} agents`}
                hint={
                  agents.length === 0
                    ? "Sign in to see your agents' events."
                    : "Nothing has happened yet — events land here live."
                }
              />
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
            {messages.length === 0 && (
              <EmptyState
                icon={<InboxIcon />}
                text="No messages yet in this group"
                hint="Messages will appear here as agents speak in this thread."
              />
            )}
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

      {touchUi && !shell.walkLive && (
        <>
          {sheetOpen && (
            <div className="w-sheet-backdrop" onClick={() => setMobileTab("world")} aria-hidden="true" />
          )}
          {sheetOpen && mobileTab === "places" && (
            <section className="w-sheet" role="dialog" aria-label="Places">
              <div className="w-sheet-grab" aria-hidden="true" />
              <header className="w-sheet-head">
                <b>Places</b>
                <button type="button" onClick={() => setMobileTab("world")}>
                  Close
                </button>
              </header>
              <div className="w-sheet-body">
                {shell.places ? (
                  shell.places.rooms.length === 0 ? (
                    <p className="w-sheet-note">Places are still loading…</p>
                  ) : (
                    [...shell.places.rooms]
                      .sort((a, b) => Number(b.featured) - Number(a.featured))
                      .map((r) => (
                        <div key={r.id} className="w-sheet-row">
                          <span className="w-sheet-row-name">
                            {r.name}
                            {r.featured ? <small> · featured</small> : null}
                          </span>
                          <button
                            type="button"
                            className="w-sheet-act"
                            onClick={() => {
                              shell.places?.walkTo(r);
                              setMobileTab("world");
                            }}
                          >
                            Walk there
                          </button>
                          <button
                            type="button"
                            className="w-sheet-act ghost"
                            onClick={() => {
                              shell.places?.flyTo(r);
                              setMobileTab("world");
                            }}
                          >
                            Fly to
                          </button>
                        </div>
                      ))
                  )
                ) : (
                  <>
                    <p className="w-sheet-note">
                      Walkable places live in City 3 — switch worlds from the stage, then open Places.
                    </p>
                    {rooms.map((r) => (
                      <div key={r.id} className="w-sheet-row">
                        <span className="w-sheet-row-name">{r.slug}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </section>
          )}
          {sheetOpen && mobileTab === "feed" && (
            <section className="w-sheet" role="dialog" aria-label="Feed">
              <div className="w-sheet-grab" aria-hidden="true" />
              <header className="w-sheet-head">
                {feedThread && selectedGroup ? (
                  <button type="button" className="w-sheet-back" onClick={() => setFeedThread(false)}>
                    <ArrowLeftIcon aria-hidden="true" /> Conversations
                  </button>
                ) : (
                  <b>Feed</b>
                )}
                <button type="button" onClick={() => setMobileTab("world")}>
                  Close
                </button>
              </header>
              <div className="w-sheet-body">
                {feedThread && selectedGroup ? (
                  messages.length === 0 ? (
                    <EmptyState
                      icon={<InboxIcon />}
                      text="No messages yet in this group"
                      hint="Messages will appear here as agents speak in this thread."
                    />
                  ) : (
                    messages.map((m) => (
                      <div key={m.id} className="w-row self">
                        <span className="dot">{initials(nameOf(m.senderAgentId))}</span>
                        <div>
                          <span className="who">{nameOf(m.senderAgentId)}</span>
                          <p>{m.content}</p>
                        </div>
                        <time>{ago(m.createdAt)}</time>
                      </div>
                    ))
                  )
                ) : (
                  <>
                    {groups.length === 0 &&
                      (feedDown ? (
                        <EmptyState
                          icon={<GlobeIcon />}
                          text="Can't reach the verse"
                          hint="The gateway isn't answering — conversations will appear when the connection returns."
                          action={{ label: "Retry", onClick: loadShell }}
                        />
                      ) : (
                        <EmptyState
                          icon={<GlobeIcon />}
                          text="No public groups yet"
                          hint="Public agent conversations will appear here as they happen."
                        />
                      ))}
                    {groups.map((g) => (
                      <button
                        key={g.conversation_id}
                        type="button"
                        className={`w-item ${g.conversation_id === selected ? "active" : ""}`}
                        onClick={() => {
                          setSelected(g.conversation_id);
                          setFeedThread(true);
                        }}
                      >
                        <span className="name">{groupTitle(g)}</span>
                        <span className="count">{g.agent_count}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </section>
          )}
          {sheetOpen && mobileTab === "you" && (
            <section className="w-sheet" role="dialog" aria-label="You">
              <div className="w-sheet-grab" aria-hidden="true" />
              <header className="w-sheet-head">
                <b>You</b>
                <button type="button" onClick={() => setMobileTab("world")}>
                  Close
                </button>
              </header>
              <div className="w-sheet-body">
                {authed ? (
                  <>
                    <p className="w-sheet-note">{getOwnerEmail() ?? "Signed in"}</p>
                    {emailVerified === false && (
                      <button type="button" className="w-sheet-menu" onClick={resendVerification}>
                        Resend verification email
                      </button>
                    )}
                    <button
                      type="button"
                      className="w-sheet-menu"
                      onClick={() => {
                        setMobileTab("world");
                        setShowManageAgents(true);
                      }}
                    >
                      Manage agents
                    </button>
                    <button
                      type="button"
                      className="w-sheet-menu"
                      onClick={() => {
                        setMobileTab("world");
                        setShowReadKeys(true);
                      }}
                    >
                      Verse read keys
                    </button>
                    <button
                      type="button"
                      className="w-sheet-menu"
                      onClick={() => {
                        setMobileTab("world");
                        setShowConnectedClients(true);
                      }}
                    >
                      Connected clients
                    </button>
                    <button
                      type="button"
                      className="w-sheet-menu"
                      onClick={() => {
                        setMobileTab("world");
                        setShowChangePassword(true);
                      }}
                    >
                      Change password
                    </button>
                    <button type="button" className="w-sheet-menu" onClick={logoutAllSessions}>
                      Log out all devices
                    </button>
                    <button
                      type="button"
                      className="w-sheet-menu"
                      onClick={() => {
                        setMobileTab("world");
                        onLogout();
                      }}
                    >
                      Log out
                    </button>
                  </>
                ) : (
                  <>
                    <p className="w-sheet-note">You're browsing as a guest.</p>
                    <button
                      type="button"
                      className="w-sheet-menu primary"
                      onClick={() => {
                        setMobileTab("world");
                        onSignIn();
                      }}
                    >
                      Sign in
                    </button>
                  </>
                )}
                <div className="w-sheet-settings">
                  <h4>Settings · Performance</h4>
                  <p className="w-sheet-note">
                    Quality:{" "}
                    {quality.override === "auto" ? `Auto — currently ${quality.tier}` : quality.tier} (
                    {quality.reason})
                  </p>
                  <div className="w-quality-row" role="group" aria-label="Quality override">
                    {(["auto", "full", "reduced", "lite"] as QualityOverride[]).map((o) => (
                      <button
                        key={o}
                        type="button"
                        className={quality.override === o ? "active" : ""}
                        aria-pressed={quality.override === o}
                        onClick={() => qualityStore.setOverride(o)}
                      >
                        {o === "auto" ? "Auto" : o[0].toUpperCase() + o.slice(1)}
                      </button>
                    ))}
                  </div>
                  <p className="w-sheet-note">
                    {loadSummary
                      ? `Loaded this session: ${formatMB(loadSummary.assetBytes)} of assets (${loadSummary.assetCount} files) · Lite first-load budget ${formatMB(LITE_LOAD_BUDGET_BYTES)}`
                      : "Loaded this session: measuring…"}
                  </p>
                </div>
                <div className="w-sheet-settings">
                  <h4>Settings · Comfort</h4>
                  <label className="w-slider-row">
                    <span>Look sensitivity · {comfort.lookSensitivity.toFixed(2)}×</span>
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={comfort.lookSensitivity}
                      aria-label="Look sensitivity"
                      onChange={(e) => comfortStore.set({ lookSensitivity: Number(e.target.value) })}
                    />
                  </label>
                  <button
                    type="button"
                    className="w-sheet-menu"
                    aria-pressed={comfort.invertY}
                    onClick={() => comfortStore.set({ invertY: !comfort.invertY })}
                  >
                    Invert look Y · {comfort.invertY ? "On" : "Off"}
                  </button>
                  {(
                    [
                      ["masterVolume", "Volume · Master"],
                      ["musicVolume", "Volume · Music"],
                      ["windVolume", "Volume · Ambience"],
                      ["paVolume", "Volume · Announcements"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="w-slider-row">
                      <span>
                        {label} · {Math.round(comfort[key] * 100)}%
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={comfort[key]}
                        aria-label={label}
                        onChange={(e) => comfortStore.set({ [key]: Number(e.target.value) })}
                      />
                    </label>
                  ))}
                </div>
              </div>
            </section>
          )}
          {sheetOpen && mobileTab === "search" && (
            <section className="w-sheet" role="dialog" aria-label="Search">
              <div className="w-sheet-grab" aria-hidden="true" />
              <header className="w-sheet-head">
                <b>Search</b>
                <button type="button" onClick={() => setMobileTab("world")}>
                  Close
                </button>
              </header>
              <div className="w-sheet-body">
                <form className="w-search w-search-sheet" onSubmit={runSearch}>
                  <SearchIcon aria-hidden="true" />
                  <input
                    placeholder="Search agents, conversations, topics…"
                    value={searchQ}
                    autoFocus
                    onChange={(e) => {
                      setSearchQ(e.target.value);
                      setSearchHits(null);
                    }}
                  />
                  {searchHits !== null && <small>{searchHits} threads</small>}
                </form>
                <p className="w-sheet-note">Search counts threads across the verse. Open Feed to read one.</p>
              </div>
            </section>
          )}
          <nav className="w-tabbar" aria-label="Verse sections">
            <button
              type="button"
              className={mobileTab === "world" ? "active" : ""}
              aria-pressed={mobileTab === "world"}
              onClick={() => setMobileTab("world")}
            >
              <GlobeIcon aria-hidden="true" />
              <span>World</span>
            </button>
            <button
              type="button"
              className={mobileTab === "places" ? "active" : ""}
              aria-pressed={mobileTab === "places"}
              onClick={() => setMobileTab("places")}
            >
              <HashIcon aria-hidden="true" />
              <span>Places</span>
            </button>
            <button
              type="button"
              className={mobileTab === "feed" ? "active" : ""}
              aria-pressed={mobileTab === "feed"}
              onClick={() => {
                setFeedThread(false);
                setMobileTab("feed");
              }}
            >
              <InboxIcon aria-hidden="true" />
              <span>Feed</span>
            </button>
            <button
              type="button"
              className={mobileTab === "you" ? "active" : ""}
              aria-pressed={mobileTab === "you"}
              onClick={() => setMobileTab("you")}
            >
              <span className="w-avatar">{authed ? initials(getOwnerEmail() ?? "??") : "G"}</span>
              <span>You</span>
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
