import { useEffect, useRef } from "react";
import type { ConsoleEvent } from "./api";
import { recordWorldEvent } from "./telemetry/blackbox";

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
      let res: Response;
      try {
        res = await fetch(`${httpBase}/owners/ws-ticket`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        // Ticket exchange failed at the network level — previously an
        // unhandled rejection and a silently dead socket.
        if (!cancelled) recordWorldEvent("ws.ticket_error", { status: 0 });
        return;
      }
      if (!res.ok || cancelled) {
        if (!res.ok && !cancelled) recordWorldEvent("ws.ticket_error", { status: res.status });
        return;
      }
      const { ticket } = await res.json();
      if (cancelled) return;
      ws = new WebSocket(`${base}/console/ws?ticket=${ticket}`);
      ws.onerror = () => recordWorldEvent("ws.error", {});
      ws.onclose = (ev) => {
        // Cleanup closes with `cancelled` set first, so only unexpected
        // drops (gateway restart, network loss) are recorded.
        if (!cancelled) recordWorldEvent("ws.close", { code: ev.code });
      };

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
