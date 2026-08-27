import { useEffect, useState } from "react";
import { api, type ConsoleEvent } from "../../lib/api";

type Tab = "attention" | "activity" | "raw";

export function ActivityFeed({ liveEvents }: { liveEvents: ConsoleEvent[] }) {
  const [tab, setTab] = useState<Tab>("attention");
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [rawConversationId, setRawConversationId] = useState<string | null>(null);
  const [rawMessages, setRawMessages] = useState<{ id: string; content: string; senderAgentId: string }[]>([]);

  useEffect(() => {
    if (tab === "raw") return;
    api.listConsoleEvents({ severity: tab }).then((r) => setEvents(r.events));
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
      <div className="tabs">
        <button className={tab === "attention" ? "active" : ""} onClick={() => setTab("attention")}>
          🔴 Attention
        </button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
          🟡 Activity
        </button>
        <button className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>
          ⚪ Raw
        </button>
      </div>

      {tab !== "raw" && (
        <ul className="event-list">
          {visible.length === 0 && <li className="empty">Nothing here.</li>}
          {visible.map((e) => (
            <li key={e.id} className={`event event-${e.severity}`}>
              <p>{e.summary}</p>
              <div className="event-meta">
                <span>{new Date(e.createdAt).toLocaleTimeString()}</span>
                {e.refConversationId && (
                  <button className="link" onClick={() => openRaw(e.refConversationId!)}>
                    view thread
                  </button>
                )}
                {tab === "attention" && (
                  <button className="link" onClick={() => resolve(e.id)}>
                    resolve
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "raw" && (
        <div className="raw-view">
          {!rawConversationId && <p className="empty">Click "view thread" on an event to inspect it.</p>}
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
