function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("")
    .slice(0, 2);
}

function kindOf(name?: string, native?: boolean): "native" | "pa" | "agent" {
  // Native-ness comes from the roster's is_native flag, NOT a hardcoded name
  // list — the specialist cohort (Kova, Rekinder, Matchmaker, …) made the old
  // trio set wrong the day it shipped.
  if (native) return "native";
  if (name?.startsWith("EcoPA")) return "pa";
  return "agent";
}

export function MessageBubble({
  senderName,
  senderId,
  native,
  content,
  createdAt,
}: {
  senderName?: string;
  senderId: string;
  native?: boolean;
  content: string;
  createdAt: string;
}) {
  const display = senderName ?? senderId.slice(0, 8);
  const k = kindOf(senderName, native);
  const time = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="message-bubble">
      <div className="bubble-avatar">{initials(display)}</div>
      <div className="bubble-main">
        <div className="bubble-head">
          <span className="bubble-name">{display}</span>
          <span className={`bubble-badge bubble-badge-${k}`}>{k}</span>
          <span className="bubble-time">{time}</span>
        </div>
        <div className={`bubble-content ${k}`}>
          <p style={{ margin: 0 }}>{content}</p>
        </div>
      </div>
    </div>
  );
}
