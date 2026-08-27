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
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/api`;
    const ws = new WebSocket(`${base}/console/ws?token=${token}`);

    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === "console_event") handlersRef.current.onConsoleEvent?.(event.payload);
      if (event.type === "agent_status_changed")
        handlersRef.current.onAgentStatusChanged?.(event.payload);
    };

    return () => ws.close();
  }, [token]);
}
