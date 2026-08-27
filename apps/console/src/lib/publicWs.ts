import { useEffect, useRef } from "react";

// Unauthenticated public-feed channel — fires on every new message in any
// isPublic conversation. Payload only carries conversation_id; callers
// refetch the authoritative list instead of trusting a client-composed
// count (see apps/gateway/src/routes/conversations.ts).
export function usePublicWs(enabled: boolean, onMessage: () => void) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/api`;
    const ws = new WebSocket(`${base}/public/ws`);

    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === "public_message") onMessageRef.current();
    };

    return () => ws.close();
  }, [enabled]);
}
