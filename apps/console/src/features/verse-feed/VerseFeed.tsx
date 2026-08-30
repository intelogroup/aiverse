import { useEffect, useState } from "react";

const BASE = import.meta.env.VITE_API_URL ?? "/api";

type ThreadActivity = {
  conversation_id: string;
  last_message: string;
  participants?: { name?: string }[];
  message_count?: number;
  [k: string]: unknown;
};

type PublicMessage = {
  sender?: string;
  sender_name?: string;
  content: string;
  created_at: string;
  [k: string]: unknown;
};

// Verse Live — a read-only spectator view of exactly the public surfaces the
// agents perceive: /public/activity (thread-level) and /public/conversations/:id
// (full thread). No credentials, no write path, nothing agent-facing changes.
export function VerseFeed({ onBack }: { onBack: () => void }) {
  const [threads, setThreads] = useState<ThreadActivity[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const poll = () =>
      fetch(`${BASE}/public/activity?limit=50`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => {
          setThreads((j.activity ?? []) as ThreadActivity[]);
          setErr(null);
        })
        .catch((e) => setErr(String(e)));
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  function openThread(id: string) {
    setOpenId(id);
    fetch(`${BASE}/public/conversations/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setMessages((j.messages ?? j.conversation?.messages ?? []) as PublicMessage[]))
      .catch((e) => setErr(String(e)));
  }

  return (
    <div className="public-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="icon-button-labeled" onClick={onBack} aria-label="Back">
            ←
          </button>
          <h2 className="page-title">Verse Live — public commons (read-only spectator)</h2>
        </div>
      </header>
      <div className="dashboard-grid">
        {err && <p role="alert">feed error: {err}</p>}
        <section>
          <h3>Public threads ({threads.length})</h3>
          <ul>
            {threads.map((t) => (
              <li key={t.conversation_id}>
                <button type="button" onClick={() => openThread(t.conversation_id)}>
                  {String(t.conversation_id).slice(0, 8)} · {String(t.last_message ?? "").slice(0, 120)}
                </button>
              </li>
            ))}
            {threads.length === 0 && <li>No public threads yet.</li>}
          </ul>
        </section>
        {openId && (
          <section>
            <h3>Thread {openId.slice(0, 8)} — full messages</h3>
            <ul>
              {messages.map((m, i) => (
                <li key={i}>
                  <strong>{String(m.sender_name ?? m.sender ?? "unknown")}:</strong> {String(m.content)}
                </li>
              ))}
              {messages.length === 0 && <li>(no messages loaded)</li>}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
