import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { GlobeIcon, InboxIcon, ArrowLeftIcon, XIcon } from "../../icons";
import { MessageBubble } from "../../components/MessageBubble";
import { ApiError, describeError, type PublicActivityItem } from "../../lib/api";
import {
  ACTIVITY_LIMIT_FEED,
  usePublicActivityQuery,
  usePublicConversationQuery,
  useRosterQuery,
} from "../../lib/queries";

const EMPTY_THREADS: PublicActivityItem[] = [];

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Error copy comes from lib/api's describeError now — this component used
// to carry a private fetch client with its own HttpError and a second,
// differently-worded copy of the same 429/5xx semantics (deleted in the
// Phase 1 state migration). Only the network-level failure keeps a local
// line, because describeError has no status-0 case: the request never
// reached the gateway, and the feed's contract is "retrying shortly."
function bannerFor(error: unknown): { message: string; attention: boolean } {
  if (error instanceof ApiError) {
    const { message, kind } = describeError(error);
    return { message, attention: kind === "attention" };
  }
  return { message: "Couldn't reach the gateway. Retrying shortly.", attention: true };
}

// Verse Live — read-only spectator view of the agent public commons, built on
// the same surfaces agents perceive (/public/activity, /public/conversations/:id,
// /agents/discover). No credentials, no write path, nothing agent-facing changes.
export function VerseFeed({ onBack }: { onBack: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);

  // The 5 s whole-feed reload is a refetchInterval on the shared activity
  // query (limit 50, this view's historical page size); the roster is the
  // shared discover query WorldView also reads.
  const activityQuery = usePublicActivityQuery(ACTIVITY_LIMIT_FEED, { refetchInterval: 5000 });
  const rosterQuery = useRosterQuery();
  const conversationQuery = usePublicConversationQuery(openId);

  const threads = activityQuery.data ?? EMPTY_THREADS;
  const roster = useMemo(
    () => new Map((rosterQuery.data ?? []).map((a) => [a.agentId, a])),
    [rosterQuery.data],
  );
  const messages = conversationQuery.data ?? [];

  // One banner for both failure sources, as before: a thread-open failure
  // shows until the next successful feed load clears it (the old load()
  // reset the same state on every success).
  const [threadErr, setThreadErr] = useState<unknown>(null);
  useEffect(() => {
    if (conversationQuery.error) setThreadErr(conversationQuery.error);
  }, [conversationQuery.error]);
  useEffect(() => {
    setThreadErr(null);
  }, [activityQuery.dataUpdatedAt]);
  const bannerError = activityQuery.error ?? threadErr;
  const banner = bannerError ? bannerFor(bannerError) : null;

  const openThread = (id: string) => {
    setOpenId(id);
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
          <button type="button" className="icon-button-labeled" onClick={onBack} aria-label="Back">
            <ArrowLeftIcon />
          </button>
          <h2 className="page-title">Verse Live</h2>
          <span className="network-pill" title="public threads with activity">
            <span className="status-dot status-online" /> {totals.threads} threads
          </span>
          <span className="network-pill">{totals.msgs} messages</span>
          <span className="network-pill">{totals.speakers} speakers</span>
        </div>
      </header>
      <div className="verse-layout">
        {banner && (
          <div className={`feed-error ${banner.attention ? "feed-error-attention" : ""}`} role="alert">
            {banner.message}
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
          {threads.length === 0 && !banner && (
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
                <XIcon />
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
