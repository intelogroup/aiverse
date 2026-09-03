import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { MessageBubble } from "../../components/MessageBubble";
import { EmptyState } from "../../components/EmptyState";
import { InboxIcon } from "../../icons";
import { usePublicWs } from "../../lib/publicWs";

type Msg = { id: string; content: string; senderAgentId: string; createdAt: string };
type RosterEntry = { name?: string; native: boolean };

export function MessageThread({ conversationId }: { conversationId: string | null }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [roster, setRoster] = useState<Map<string, RosterEntry>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      if (!conversationId) return;
      setLoading(true);
      try {
        const [conv, disc] = await Promise.all([
          api.publicConversation(conversationId).catch(() => ({ messages: [] as Msg[] })),
          api.discoverRoster(),
        ]);
        if (cancelled) return;
        setMessages((conv.messages ?? []) as Msg[]);
        const m = new Map<string, RosterEntry>();
        for (const a of disc.roster ?? [])
          m.set(a.agentId, { name: a.name, native: !!(a as any).isNative });
        setRoster(m);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Live refresh: a new public message re-fetches the open thread so the
  // "live" claim in the header is true. Cheap — the thread is one small GET.
  usePublicWs(!!conversationId, () => {
    if (!conversationId) return;
    api
      .publicConversation(conversationId)
      .then((conv) => setMessages((conv.messages ?? []) as Msg[]))
      .catch(() => {});
  });

  if (!conversationId) {
    return (
      <div className="message-stream">
        <EmptyState
          icon={<InboxIcon />}
          text="Select a thread"
          hint="Pick a conversation from the left to see messages. Agent chats appear here live."
        />
      </div>
    );
  }

  if (loading && messages.length === 0)
    return <div className="message-stream"><p className="empty">Loading…</p></div>;

  if (messages.length === 0) {
    return (
      <div className="message-stream">
        <EmptyState icon={<InboxIcon />} text="No messages yet" hint="This thread exists but has no messages." />
      </div>
    );
  }

  return (
    <div className="message-stream">
      <div style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "center", padding: "4px 0" }}>
        {messages.length} messages · {conversationId.slice(0, 8)}
      </div>
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          senderId={m.senderAgentId}
          senderName={roster.get(m.senderAgentId)?.name}
          native={roster.get(m.senderAgentId)?.native}
          content={m.content}
          createdAt={m.createdAt}
        />
      ))}
    </div>
  );
}
