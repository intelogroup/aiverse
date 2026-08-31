import { useEffect, useRef, useState } from "react";
import { api, type ConsoleEvent } from "../../lib/api";
import { usePublicWs } from "../../lib/publicWs";

type ThreadRow = {
  conversation_id: string;
  last_message: string;
  last_sender_agent_id: string;
  last_message_at: string;
  agent_count: number;
  message_count: number;
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > n * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

export function ThreadList({
  selectedId,
  onSelect,
  liveEvents,
  roster,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  liveEvents: ConsoleEvent[];
  roster?: Record<string, { name: string; isNative: boolean }>;
}) {
  const [filter, setFilter] = useState<"all" | "attention" | "activity">("all");
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [showQuiet, setShowQuiet] = useState(false);
  const knownThreads = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const fetchThreads = async () => {
    try {
      const r = await api.publicActivity();
      const rows = r.activity as ThreadRow[];
      // rank by recency
      rows.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
      // "new" badge: thread we hadn't seen before this poll with fresh activity
      for (const t of rows) {
        (t as any).isNew =
          primed.current && !knownThreads.current.has(t.conversation_id) &&
          Date.now() - new Date(t.last_message_at).getTime() < 5 * 60_000;
        knownThreads.current.add(t.conversation_id);
      }
      primed.current = true;
      setThreads(rows);
    } catch {}
  };

  const fetchEvents = async () => {
    if (filter === "all") return;
    try {
      const r = await api.listConsoleEvents({ severity: filter });
      setEvents(r.events);
    } catch {}
  };

  useEffect(() => {
    fetchThreads();
  }, []);
  useEffect(() => {
    fetchEvents();
  }, [filter]);

  usePublicWs(true, fetchThreads);

  // live console events merge
  const visibleEvents = [
    ...liveEvents.filter((e) => e.severity === filter && !events.some((x) => x.id === e.id)),
    ...events,
  ];

  return (
    <div className="thread-list-pane">
      <div className="thread-filter">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
          All chats
        </button>
        <button className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")}>
          Needs you
        </button>
        <button className={filter === "activity" ? "active" : ""} onClick={() => setFilter("activity")}>
          Activity
        </button>
      </div>

      {filter !== "all" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {visibleEvents.length === 0 && <p className="empty">No events</p>}
          {visibleEvents.map((e) => (
            <button
              key={e.id}
              className={`thread-row ${selectedId === e.refConversationId ? "active" : ""}`}
              onClick={() => e.refConversationId && onSelect(e.refConversationId)}
            >
              <div className="thread-row-top">
                <span className="thread-row-title">{trunc(e.summary, 56)}</span>
                <span className="thread-row-time">{ago(e.createdAt)}</span>
              </div>
              <span className="thread-row-snippet">{trunc(e.summary, 88)}</span>
            </button>
          ))}
        </div>
      ) : (
        (() => {
          const nameOf = (id: string) => roster?.[id]?.name ?? id.slice(0, 8);
          const active = threads.filter(
            (t) => t.message_count > 1 || Date.now() - new Date(t.last_message_at).getTime() < 60 * 60_000,
          );
          const quiet = threads.filter(
            (t) => t.message_count <= 1 && Date.now() - new Date(t.last_message_at).getTime() >= 60 * 60_000,
          );
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="inbox-section-label">Active threads · {active.length}</div>
              {active.length === 0 && <p className="empty">Nothing active right now</p>}
              {active.map((t) => (
                <button
                  key={t.conversation_id}
                  className={`thread-row ${selectedId === t.conversation_id ? "active" : ""}`}
                  onClick={() => onSelect(t.conversation_id)}
                >
                  <div className="thread-row-top">
                    <span className="thread-row-title">
                      {(t as any).isNew && <span className="new-badge">new</span>}
                      {trunc(t.last_message, 52) || "Untitled thread"}
                    </span>
                    <span className="thread-row-time">{ago(t.last_message_at)}</span>
                  </div>
                  <span className="thread-row-snippet">{trunc(t.last_message, 96)}</span>
                  <span className="thread-row-meta">
                    <span>{t.agent_count} agents</span>·<span>{t.message_count} msgs</span>·
                    <span>{nameOf(t.last_sender_agent_id)}</span>
                  </span>
                </button>
              ))}
              {quiet.length > 0 && (
                <>
                  <button type="button" className="quiet-toggle" onClick={() => setShowQuiet((v) => !v)}>
                    {showQuiet ? "▾" : "▸"} Quiet threads ({quiet.length})
                  </button>
                  {showQuiet &&
                    quiet.map((t) => (
                      <button
                        key={t.conversation_id}
                        className={`thread-row quiet ${selectedId === t.conversation_id ? "active" : ""}`}
                        onClick={() => onSelect(t.conversation_id)}
                      >
                        <div className="thread-row-top">
                          <span className="thread-row-title">{trunc(t.last_message, 52) || "Untitled thread"}</span>
                          <span className="thread-row-time">{ago(t.last_message_at)}</span>
                        </div>
                        <span className="thread-row-meta">
                          <span>{t.message_count} msg</span>·<span>{nameOf(t.last_sender_agent_id)}</span>
                        </span>
                      </button>
                    ))}
                </>
              )}
            </div>
          );
        })()
      )}
    </div>
  );
}
