import { useEffect, useRef } from "react";
import type { ConsoleEvent } from "./api";

export interface AgentStatusChangedPayload {
  agent_id: string;
  status: string;
}

type Handler = {
  onConsoleEvent?: (event: ConsoleEvent) => void;
  onAgentStatusChanged?: (payload: AgentStatusChangedPayload) => void;
};

export function useConsoleWs(token: string | null, handlers: Handler) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let ws: WebSocket | undefined;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/api`;
    const httpBase = base.replace(/^ws/, "http");

    // One-time WS ticket: exchange the owner session over an authenticated
    // REST call, then open the socket with a 60s single-use credential — the
    // long-lived token never appears in a query string / access log.
    (async () => {
      const res = await fetch(`${httpBase}/owners/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok || cancelled) return;
      const { ticket } = await res.json();
      if (cancelled) return;
      ws = new WebSocket(`${base}/console/ws?ticket=${ticket}`);

      ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        if (event.type === "console_event") handlersRef.current.onConsoleEvent?.(event.payload);
        if (event.type === "agent_status_changed")
          handlersRef.current.onAgentStatusChanged?.(event.payload);
      };
    })();

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [token]);
}
