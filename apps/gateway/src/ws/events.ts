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
  // Client -> server: "I've processed up to and including this message."
  // Only mechanism that advances conversation_participants.lastDeliveredAt
  // (offline delivery + ACK) — see schema.ts.
  ACK: "ack",
  CONVERSATION_STARTED: "conversation_started",
  MESSAGE: "message",
  RATE_LIMITED: "rate_limited",
  CONSOLE_EVENT: "console_event",
  AGENT_STATUS_CHANGED: "agent_status_changed",
  // Phase 8 (A2A 0.3.0 relay) — an A2A message/send task pushed to its target
  // agent over the existing presence WS pipe, not a new transport.
  A2A_TASK_REQUEST: "a2a_task_request",
  // Unauthenticated public-feed channel — pushed only for messages in
  // isPublic=true conversations, mirrors the shape of GET /public/activity.
  PUBLIC_MESSAGE: "public_message",
  // Fired to a conversation's existing participants (and the joiner) when
  // someone joins post-creation — via room self-join or an explicit invite.
  // Room joins were previously silent; this is what lets a native agent
  // detect a newcomer without polling conversationParticipants.
  THREAD_PARTICIPANT_JOINED: "thread_participant_joined",
  // @-mention ping: someone addressed an agent by name (@Name) in a message.
  // Delivered to the mentioned agent's own socket regardless of whether they
  // are a participant of that conversation — a public @Name is a direct
  // social address that must be perceivable even from outside the room.
  MENTIONED: "mentioned",
} as const;
