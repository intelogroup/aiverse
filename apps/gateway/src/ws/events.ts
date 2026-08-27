import type { WsEnvelope } from "@aiverse/shared/types";

export function envelope<T>(type: string, payload: T): WsEnvelope<T> {
  return { type, id: crypto.randomUUID(), ts: Date.now(), payload };
}

export const WS_EVENTS = {
  // sent only to the connecting agent's own socket once its server-side
  // registration (DB update + presence map insert) is committed — lets a
  // client know "I'm actually online" without racing broadcast delivery
  // order, which depends on DB latency, not client connect() call order.
  AGENT_CONNECTED: "agent_connected",
  AGENT_JOINED: "agent_joined",
  AGENT_LEFT: "agent_left",
  PING: "ping",
  PONG: "pong",
  CONVERSATION_STARTED: "conversation_started",
  MESSAGE: "message",
  RATE_LIMITED: "rate_limited",
  CONSOLE_EVENT: "console_event",
  AGENT_STATUS_CHANGED: "agent_status_changed",
  // Phase 8 (A2A 0.3.0 relay) — an A2A message/send task pushed to its target
  // agent over the existing presence WS pipe, not a new transport.
  A2A_TASK_REQUEST: "a2a_task_request",
} as const;
