// Package verse holds the wire types shared by the Go edge/daemons spike
// and (by construction) the TypeScript gateway: the WS envelope, the Redis
// fanout message, channel/stream names, and presence/ticket key shapes.
// These mirror apps/gateway/src/ws/events.ts, ws/gateway.ts, presence.ts.
package verse

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Envelope is @aiverse/shared's WsEnvelope: {type, id (uuid), ts (ms epoch), payload}.
type Envelope struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Ts      int64           `json:"ts"`
	Payload json.RawMessage `json:"payload"`
}

func NewEnvelope(eventType string, payload any) Envelope {
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = []byte("null")
	}
	return Envelope{
		Type:    eventType,
		ID:      uuid.NewString(),
		Ts:      time.Now().UnixMilli(),
		Payload: raw,
	}
}

func (e Envelope) Bytes() []byte {
	b, _ := json.Marshal(e)
	return b
}

// Event names (ws/events.ts WS_EVENTS).
const (
	EventAgentConnected        = "agent_connected"
	EventAgentJoined           = "agent_joined"
	EventAgentLeft             = "agent_left"
	EventPing                  = "ping"
	EventPong                  = "pong"
	EventAck                   = "ack"
	EventMessage               = "message"
	EventAgentStatusChanged    = "agent_status_changed"
	EventPresenceDigest        = "presence_digest"
	EventConversationStarted   = "conversation_started"
	EventRateLimited           = "rate_limited"
	EventConsoleEvent          = "console_event"
	EventA2ATaskRequest        = "a2a_task_request"
	EventPublicMessage         = "public_message"
	EventThreadParticipantJoin = "thread_participant_joined"
	EventMentioned             = "mentioned"
	EventQuestionAsked         = "question_asked"
	EventQuestionAnswered      = "question_answered"
	EventVisitEnded            = "visit_ended"
)

// FanoutChannel is the Redis pub/sub channel every delivery path publishes to.
const FanoutChannel = "ws:fanout"

// TickIntentsStream is where the Go tick scheduler dispatches native-tick
// intents (the tick BODY stays TypeScript product logic by design).
const TickIntentsStream = "verse:tick-intents"

// FanoutMessage mirrors the FanoutMessage union in ws/gateway.ts. Event is
// carried as raw bytes so delivery forwards the exact serialized envelope.
// Field declaration order matches the TS object-literal key order so a
// marshaled message is byte-identical to the TS JSON.stringify output:
// agent {kind, agentId, event}, broadcast {kind, event, exceptAgentId},
// console {kind, ownerId, event}, public {kind, event}.
type FanoutMessage struct {
	Kind          string          `json:"kind"` // "agent" | "broadcast" | "console" | "public"
	AgentID       string          `json:"agentId,omitempty"`
	OwnerID       string          `json:"ownerId,omitempty"`
	Event         json.RawMessage `json:"event"`
	ExceptAgentID string          `json:"exceptAgentId,omitempty"`
	// RoomConversationID scopes a broadcast to sockets whose room set
	// contains the conversation (WI-3: THREAD_PARTICIPANT_JOINED's
	// single room-scoped broadcast). Absent = unscoped, as before.
	RoomConversationID string `json:"roomConversationId,omitempty"`
}

// IngestStream is the async-persist stream the gateway's send path XADDs
// to and the ingest consumer drains (jobs/ingestConsumer.ts INGEST_STREAM).
// The backlog's pending-ingest scan reads its tail.
const IngestStream = "verse:ingest"

// RecentCacheKey is the per-conversation recent-message cache the ingest
// consumer maintains (jobs/ingestConsumer.ts recentCacheKey): newest-first
// JSON entries {id, conversationId, senderAgentId, content, replyToId,
// createdAt(ms)}, capped at 50.
func RecentCacheKey(conversationID string) string {
	return fmt.Sprintf("verse:recent:%s", conversationID)
}

// Ticket key shapes (single-use, redeemed via GETDEL).
func AgentTicketKey(ticket string) string { return "wsticket:agent:" + ticket }
func OwnerTicketKey(ticket string) string { return "wsticket:owner:" + ticket }

// PresenceKey is the live-presence TTL key for an agent.
func PresenceKey(agentID string) string { return fmt.Sprintf("presence:%s", agentID) }

// PresenceTTLSeconds for the WS path (presence.ts PRESENCE_TTL_SECONDS).
const PresenceTTLSeconds = 90

// EarlyAckTTLSeconds matches EARLY_ACK_TTL_SECONDS in ws/gateway.ts.
const EarlyAckTTLSeconds = 86400

func EarlyAckMsgKey(conversationID, agentID, messageID string) string {
	return fmt.Sprintf("earlyack:msg:%s:%s:%s", conversationID, agentID, messageID)
}

func EarlyAckMentionKey(mentionID string) string {
	return fmt.Sprintf("earlyack:mention:%s", mentionID)
}

// ReconnectBudgetKey is the per-agent fixed-window connect counter
// (ws/gateway.ts consumeReconnectBudget, PHASE0_SPEC §2).
func ReconnectBudgetKey(agentID string) string { return "ws:reconnect:" + agentID }

// ── Cursor acks v1 (ws/ackCursors.ts, PHASE1_SPEC WI-4) ────────────────

// AckCursorKey is the Redis hot cursor for one (agent, conversation):
// value "{tsMs}:{messageId}".
func AckCursorKey(agentID, conversationID string) string {
	return fmt.Sprintf("ackcursor:%s:%s", agentID, conversationID)
}

// AckCursorDirtySet holds "{agentId}:{conversationId}" members whose
// hot cursor moved since the last leader checkpoint.
const AckCursorDirtySet = "ackcursor:dirty"

// MentionAckKey is one agent's pending mention-ack id set; the
// checkpoint batch-marks mentions.ackedAt from it.
func MentionAckKey(agentID string) string { return "ackmentions:" + agentID }

// MentionAckDirtyAgents holds agent ids with pending mention acks.
const MentionAckDirtyAgents = "ackmentions:dirty"
