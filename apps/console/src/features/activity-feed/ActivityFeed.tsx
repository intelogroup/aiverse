import { useEffect, useState } from "react";
import { api, type ConsoleEvent } from "../../lib/api";
import { EmptyState } from "../../components/EmptyState";
import { BellIcon, InboxIcon } from "../../icons";

type Tab = "attention" | "activity" | "raw";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ActivityFeed({ liveEvents }: { liveEvents: ConsoleEvent[] }) {
  const [tab, setTab] = useState<Tab>("attention");
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [rawConversationId, setRawConversationId] = useState<string | null>(null);
  const [rawMessages, setRawMessages] = useState<{ id: string; content: string; senderAgentId: string }[]>([]);

  useEffect(() => {
    if (tab === "raw") return;
    setLoading(true);
    api.listConsoleEvents({ severity: tab }).then((r) => {
      setEvents(r.events);
      setLoading(false);
    });
  }, [tab]);

  // merge live-pushed events of the currently viewed severity in at the top
  const visible = [
    ...liveEvents.filter((e) => e.severity === tab && !events.some((x) => x.id === e.id)),
    ...events,
  ];

  async function resolve(id: string) {
    await api.resolveConsoleEvent(id);
    setEvents((prev) => prev.filter((e) => e.id !== id));
  }

  async function openRaw(conversationId: string) {
    setRawConversationId(conversationId);
    setTab("raw");
    const res = await api.conversationMessages(conversationId);
    setRawMessages(res.messages as typeof rawMessages);
  }

  return (
    <div className="activity-feed">
      <div className="segmented tabs">
        <button type="button" className={tab === "attention" ? "active" : ""} onClick={() => setTab("attention")}>
          Attention
        </button>
        <button type="button" className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
          Activity
        </button>
        <button type="button" className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>
          Raw
        </button>
      </div>

      {tab !== "raw" && (
        <ul className="event-list">
          {!loading && visible.length === 0 && (
            <EmptyState
              icon={<BellIcon />}
              text={tab === "attention" ? "All clear" : "No activity yet"}
              hint={
                tab === "attention"
                  ? "Nothing needs your approval right now — agents are running within their budgets."
                  : "Agent sends, joins, and budget events will show up here as they happen."
              }
            />
          )}
          {visible.map((e) => (
            <li key={e.id} className={`event event-${e.severity}`}>
              <p>{e.summary}</p>
              <div className="event-meta">
                <span className="event-time">{relativeTime(e.createdAt)}</span>
                <span className="event-actions">
                  {e.refConversationId && (
                    <button type="button" className="link" onClick={() => openRaw(e.refConversationId!)}>
                      view thread
                    </button>
                  )}
                  {tab === "attention" && (
                    <button type="button" className="link" onClick={() => resolve(e.id)}>
                      resolve
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "raw" && (
        <div className="raw-view">
          {!rawConversationId && (
            <EmptyState
              icon={<InboxIcon />}
              text="No thread selected"
              hint='Click "view thread" on an event to inspect the raw conversation.'
            />
          )}
          {rawConversationId && (
            <ul className="message-list">
              {rawMessages.map((m) => (
                <li key={m.id}>
                  <strong>{m.senderAgentId.slice(0, 8)}</strong>: {m.content}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
