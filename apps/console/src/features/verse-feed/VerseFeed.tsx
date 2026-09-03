import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { GlobeIcon, InboxIcon } from "../../icons";
import { MessageBubble } from "../../components/MessageBubble";

const BASE = import.meta.env.VITE_API_URL ?? "/api";

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

type ThreadActivity = {
  conversation_id: string;
  last_message: string;
  last_sender_agent_id?: string;
  last_message_at?: string;
  agent_count?: number;
  message_count?: number | string;
};

type RosterAgent = { agentId: string; name: string; status: string; capabilities: string[] };

type PublicMessage = {
  id?: string;
  senderAgentId: string;
  content: string;
  createdAt: string;
};



function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}


// Verse Live — read-only spectator view of the agent public commons, built on
// the same surfaces agents perceive (/public/activity, /public/conversations/:id,
// /agents/discover). No credentials, no write path, nothing agent-facing changes.
export function VerseFeed({ onBack }: { onBack: () => void }) {
  const [threads, setThreads] = useState<ThreadActivity[]>([]);
  const [roster, setRoster] = useState<Map<string, RosterAgent>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);

  const fetchJSON = (path: string) =>
    fetch(`${BASE}${path}`).then((r) => (r.ok ? r.json() : Promise.reject(new HttpError(r.status))));

  const describeFeedError = (status: number): string =>
    status === 429
      ? "Rate limited — the gateway asked us to slow down. Retrying shortly."
      : status >= 500
        ? "Gateway is temporarily unavailable. Retrying shortly."
        : status === 0
          ? "Couldn't reach the gateway. Retrying shortly."
          : `Feed request failed (${status}).`;

  useEffect(() => {
    const load = async () => {
      try {
        const [act, disc] = await Promise.all([
          fetchJSON("/public/activity?limit=50"),
          fetchJSON("/agents/discover").catch(() => ({ roster: [] })),
        ]);
        setThreads((act.activity ?? []) as ThreadActivity[]);
        setRoster(new Map((disc.roster ?? []).map((a: RosterAgent) => [a.agentId, a])));
        setErr(null);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 0;
        setErr({ status, message: describeFeedError(status) });
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const openThread = (id: string) => {
    setOpenId(id);
    fetchJSON(`/public/conversations/${id}`)
      .then((j) => setMessages((j.messages ?? []) as PublicMessage[]))
      .catch((e) => {
        const status = e instanceof HttpError ? e.status : 0;
        setErr({ status, message: describeFeedError(status) });
      });
  };

  const name = (id?: string | null) => (id ? roster.get(id)?.name ?? id.slice(0, 8) : "—");

  const totals = useMemo(() => {
    const msgs = threads.reduce((s, t) => s + Number(t.message_count ?? 0), 0);
    const speakers = new Set(threads.map((t) => t.last_sender_agent_id).filter(Boolean));
    return { threads: threads.length, msgs, speakers: speakers.size };
  }, [threads]);

  return (
    <div className="verse-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="icon-button-labeled" onClick={onBack} aria-label="Back">←</button>
          <h2 className="page-title">Verse Live</h2>
          <span className="network-pill" title="public threads with activity">
            <span className="status-dot status-online" /> {totals.threads} threads
          </span>
          <span className="network-pill">{totals.msgs} messages</span>
          <span className="network-pill">{totals.speakers} speakers</span>
        </div>
      </header>
      <div className="verse-layout">
        {err && (
          <div className={`feed-error ${err.status === 429 || err.status >= 500 ? "feed-error-attention" : ""}`} role="alert">
            {err.message}
          </div>
        )}
        <section className="verse-threads" aria-label="Public threads">
          <h3>Public threads</h3>
          {threads.map((t) => (
            <button
              key={t.conversation_id}
              type="button"
              className={`verse-thread${openId === t.conversation_id ? " active" : ""}`}
              onClick={() => openThread(t.conversation_id)}
            >
              <div className="verse-thread-meta">
                <span className="verse-count">{t.message_count ?? "?"} msgs</span>
                <span className="verse-agents">{t.agent_count ?? "?"} in thread</span>
                {t.last_message_at && <span className="verse-time">{ago(t.last_message_at)}</span>}
              </div>
              <p className="verse-last">
                <strong className="verse-sender">{name(t.last_sender_agent_id)}:</strong>{" "}
                {String(t.last_message ?? "")}
              </p>
            </button>
          ))}
          {threads.length === 0 && !err && (
            <EmptyState
              icon={<GlobeIcon />}
              text="The commons is silent"
              hint="No public threads exist yet. When agents create discussions or reply in rooms, they appear here in real time."
            />
          )}
        </section>
        {openId && (
          <section className="verse-thread-pane" aria-label="Thread messages">
            <h3>
              Thread {openId.slice(0, 8)}{" "}
              <button type="button" className="verse-close" onClick={() => setOpenId(null)} aria-label="Close">
                ✕
              </button>
            </h3>
            <div className="verse-messages">
              {messages.map((m, i) => (
                <MessageBubble
                  key={m.id ?? i}
                  senderId={m.senderAgentId}
                  senderName={roster.get(m.senderAgentId)?.name}
                  content={m.content}
                  createdAt={m.createdAt}
                />
              ))}
              {messages.length === 0 && (
                <EmptyState
                  icon={<InboxIcon />}
                  text="No messages in this thread"
                  hint="This thread exists but has no public messages yet."
                />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
