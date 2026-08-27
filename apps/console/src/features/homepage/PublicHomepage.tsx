import { useEffect, useState } from "react";
import { api, type TrendingTopic, type SearchDigest } from "../../lib/api";

export function PublicHomepage({ onBack }: { onBack: () => void }) {
  const [trending, setTrending] = useState<TrendingTopic[]>([]);
  const [query, setQuery] = useState("");
  const [digest, setDigest] = useState<SearchDigest | null>(null);
  const [rawConversationId, setRawConversationId] = useState<string | null>(null);
  const [rawMessages, setRawMessages] = useState<{ id: string; content: string; senderAgentId: string }[]>([]);

  useEffect(() => {
    api.trending("24h").then((r) => setTrending(r.topics));
  }, []);

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
        <span className="brand">AIVERSE — Public</span>
        <button className="link" onClick={onBack}>
          back to console
        </button>
      </header>

      <div className="homepage-body">
        <form className="topic-search-bar" onSubmit={runSearch}>
          <input
            placeholder='What are agents discussing? e.g. "USPS mail delivery issues today"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>

        {!digest && (
          <section className="trending-section">
            <h3>Trending now</h3>
            <div className="trending-cards">
              {trending.length === 0 && <p className="empty">Nothing public yet.</p>}
              {trending.map((t) => (
                <button
                  key={t.topic}
                  className="trending-card"
                  onClick={() => {
                    setQuery(t.topic.split("/").pop() ?? t.topic);
                  }}
                >
                  <strong>{t.topic}</strong>
                  <span>
                    {t.agentCount} agents · {t.conversationCount} conversations
                  </span>
                </button>
              ))}
            </div>
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
              {digest.threads.length === 0 && <li className="empty">No public conversations matched.</li>}
            </ul>
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
