import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type RosterEntry } from "../lib/api";

export function ChatOverlay({
  conversationId,
  title,
  myAgentIds,
  roster,
  onClose,
}: {
  conversationId: string;
  title: string;
  myAgentIds: Set<string>;
  roster: Record<string, RosterEntry>;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  const nameOf = (id: string) => roster[id]?.name ?? (id ? id.slice(0, 8) : "?");
  const isNative = (id: string) => roster[id]?.isNative ?? false;
  const mine = (id: string) => myAgentIds.has(id);

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const load = async () => {
      try {
        const r = await api.conversationMessages(conversationId);
        if (cancelled) return;
        const list = r.messages ?? [];
        if (first) {
          setMessages(list);
          prevCount.current = list.length;
          first = false;
          requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
        } else if (list.length > prevCount.current) {
          const fresh = new Set(list.slice(prevCount.current).map((m) => m.id));
          setNewIds(fresh);
          setMessages(list);
          prevCount.current = list.length;
          requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
          setTimeout(() => setNewIds(new Set()), 1600);
        }
      } catch {}
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [conversationId]);

  // anchor side: first sender's side is left; my agents always right
  const firstSender = messages?.[0]?.senderAgentId;
  const sideOf = (senderId: string) =>
    mine(senderId) || (firstSender ? senderId !== firstSender && !mine(firstSender) && false : false)
      ? "mine-side"
      : senderId === firstSender
        ? "other-side"
        : mine(senderId)
          ? "mine-side"
          : "other-side";

  return (
    <div className="chat-overlay" onClick={onClose}>
      <div className="chat-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-head">
          <span className="title">{title}</span>
          <span className="meta">{messages ? `${messages.length} messages · live tail on` : "loading…"}</span>
          <button className="close" onClick={onClose}>✕</button>
        </div>
        <div className="chat-scroll" ref={scrollRef}>
          {messages === null ? (
            <>
              <div className="skeleton-bubble other-side" />
              <div className="skeleton-bubble mine-side" />
              <div className="skeleton-bubble other-side" />
            </>
          ) : (
            messages.map((m) => {
              const cls = sideOf(m.senderAgentId);
              const idcls = mine(m.senderAgentId) ? "mine-id" : isNative(m.senderAgentId) ? "native-id" : "";
              return (
                <div key={m.id} className={`msg ${cls} ${newIds.has(m.id) ? "new-msg" : ""}`}>
                  <div className={`msg-id ${idcls}`}>
                    <span className="name">{mine(m.senderAgentId) ? "✦ " : ""}{nameOf(m.senderAgentId)}</span>
                    <span className="ts">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="bubble">{m.content}</div>
                </div>
              );
            })
          )}
        </div>
        <div className="chat-foot">
          <span className="live-on">● live tail on</span>
          <span>new messages stream in as the agents speak</span>
        </div>
      </div>
    </div>
  );
}
