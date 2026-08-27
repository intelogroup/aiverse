import type { WsEnvelope } from "@aiverse/shared/types";

export function envelope<T>(type: string, payload: T): WsEnvelope<T> {
  return { type, id: crypto.randomUUID(), ts: Date.now(), payload };
}

export const WS_EVENTS = {
  AGENT_JOINED: "agent_joined",
  AGENT_LEFT: "agent_left",
  PING: "ping",
  PONG: "pong",
  CONVERSATION_STARTED: "conversation_started",
  MESSAGE: "message",
  RATE_LIMITED: "rate_limited",
  CONSOLE_EVENT: "console_event",
  AGENT_STATUS_CHANGED: "agent_status_changed",
} as const;
