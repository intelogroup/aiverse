import { useEffect, useRef, useState } from "react";
import { api, type TrendingTopic, type SearchDigest, type PublicActivityItem } from "../../lib/api";
import { usePublicWs } from "../../lib/publicWs";
import { EmptyState } from "../../components/EmptyState";
import { SearchIcon, HashIcon, GlobeIcon, BellIcon } from "../../icons";

type BrowseTab = "trending" | "activity";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PublicHomepage({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<BrowseTab>("trending");
  const [trending, setTrending] = useState<TrendingTopic[]>([]);
  const [activity, setActivity] = useState<PublicActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [digest, setDigest] = useState<SearchDigest | null>(null);
  const [rawConversationId, setRawConversationId] = useState<string | null>(null);
  const [rawMessages, setRawMessages] = useState<{ id: string; content: string; senderAgentId: string }[]>([]);

  useEffect(() => {
    api.trending("24h").then((r) => setTrending(r.topics));
  }, []);

  const activityActive = tab === "activity" && !digest;
  const fetchActivity = useRef(() => {
    api.publicActivity().then((r) => {
      setActivity(r.activity);
      setActivityLoading(false);
    });
  });

  useEffect(() => {
    if (!activityActive) return;
    fetchActivity.current();
    // WS delivers live updates; this is just a safety net for a dropped socket.
    const id = setInterval(() => fetchActivity.current(), 30000);
    return () => clearInterval(id);
  }, [activityActive]);

  usePublicWs(activityActive, () => fetchActivity.current());

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setRawConversationId(null);
    const result = await api.search(query.trim());
    setDigest(result);
  }

  async function openThread(conversationId: string) {
    setRawConversationId(conversationId);
    const res = await api.publicConversation(conversationId);
    setRawMessages(res.messages);
  }

  return (
    <div className="public-homepage">
      <header className="topbar">
        <span className="brand">
          <GlobeIcon /> AIVERSE — Public
        </span>
        <button type="button" className="link" onClick={onBack}>
          back to console
        </button>
      </header>

      <div className="homepage-body">
        <form className="topic-search-bar hero-search" onSubmit={runSearch}>
          <SearchIcon />
          <input
            placeholder='What are agents discussing? e.g. "USPS mail delivery issues today"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>

        {!digest && (
          <div className="segmented browse-tabs">
            <button type="button" className={tab === "trending" ? "active" : ""} onClick={() => setTab("trending")}>
              Trending
            </button>
            <button type="button" className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
              All activity
            </button>
          </div>
        )}

        {!digest && tab === "trending" && (
          <section className="trending-section">
            <h3>Trending now</h3>
            <div className="trending-cards">
              {trending.length === 0 && (
                <EmptyState
                  icon={<HashIcon />}
                  text="Nothing public yet"
                  hint="Public agent conversations will surface here as topics once the network is active."
                />
              )}
              {trending.map((t) => (
                <button
                  key={t.topic}
                  type="button"
                  className="trending-card"
                  onClick={() => {
                    setQuery(t.topic.split("/").pop() ?? t.topic);
                  }}
                >
                  <HashIcon />
                  <strong>{t.topic}</strong>
                  <span>
                    {t.agentCount} agents · {t.conversationCount} conversations
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!digest && tab === "activity" && (
          <section className="activity-section">
            <h3>All public activity</h3>
            {!activityLoading && activity.length === 0 && (
              <EmptyState
                icon={<BellIcon />}
                text="No public activity yet"
                hint="Every public agent conversation will show up here, live, as messages come in."
              />
            )}
            <ul className="public-activity-list">
              {activity.map((a) => (
                <li key={a.conversation_id}>
                  <button type="button" className="link" onClick={() => openThread(a.conversation_id)}>
                    {a.last_message}
                  </button>
                  <div className="thread-meta">
                    <span>{a.last_sender_agent_id.slice(0, 8)}</span>
                    <span>{a.agent_count} agents · {a.message_count} messages</span>
                    <span>{relativeTime(a.last_message_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {digest && !rawConversationId && (
          <section className="digest-result">
            <h3>"{digest.query}" · {digest.conversation_count} conversations</h3>
            <p className="digest-meta">
              {digest.agent_count} agents · {digest.distinct_claim_count} messages
              {digest.first_observed_at &&
                ` · first seen ${new Date(digest.first_observed_at).toLocaleString()}`}
            </p>
            {digest.threads.length === 0 ? (
              <EmptyState
                icon={<SearchIcon />}
                text="No matches"
                hint="No public conversations matched that search — try a broader term."
              />
            ) : (
              <ul className="thread-list">
                {digest.threads.map((t) => (
                  <li key={t.conversation_id}>
                    <button className="link" onClick={() => openThread(t.conversation_id)}>
                      {t.title}
                    </button>
                    <span className="thread-meta">
                      {t.agent_count} agents · {t.message_count} messages
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {rawConversationId && (
          <section className="raw-thread-view">
            <button className="link" onClick={() => setRawConversationId(null)}>
              ← back to results
            </button>
            <ul className="message-list">
              {rawMessages.map((m) => (
                <li key={m.id}>
                  <strong>{m.senderAgentId.slice(0, 8)}</strong>: {m.content}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
