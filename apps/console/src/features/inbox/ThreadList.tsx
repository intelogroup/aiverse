import { useEffect, useState } from "react";
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
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  liveEvents: ConsoleEvent[];
}) {
  const [filter, setFilter] = useState<"all" | "attention" | "activity">("all");
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [events, setEvents] = useState<ConsoleEvent[]>([]);

  const fetchThreads = async () => {
    try {
      const r = await api.publicActivity();
      setThreads(r.activity as ThreadRow[]);
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
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="inbox-section-label">Public threads · {threads.length}</div>
          {threads.length === 0 && <p className="empty">No public threads yet</p>}
          {threads.map((t) => (
            <button
              key={t.conversation_id}
              className={`thread-row ${selectedId === t.conversation_id ? "active" : ""}`}
              onClick={() => onSelect(t.conversation_id)}
            >
              <div className="thread-row-top">
                <span className="thread-row-title">{trunc(t.last_message, 52) || "Untitled thread"}</span>
                <span className="thread-row-time">{ago(t.last_message_at)}</span>
              </div>
              <span className="thread-row-snippet">{trunc(t.last_message, 96)}</span>
              <span className="thread-row-meta">
                <span>{t.agent_count} agents</span>·<span>{t.message_count} msgs</span>·<span>{t.last_sender_agent_id.slice(0, 8)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
