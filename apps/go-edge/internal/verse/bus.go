package verse

import (
	"crypto/rand"
	"fmt"
	"time"
)

// ── Bus subjects (PHASE2_SPEC WI-2 step 1) ─────────────────────────────
// The fanout bus's transport-agnostic subject design, mirrored by
// apps/gateway/src/ws/bus.ts: room.{conversationId} for room traffic,
// agent.{agentId} for direct traffic, fleet.control for
// membership/heartbeat/subscription reports, fleet.broadcast for the
// genuinely-global events, console.{ownerId} for owner console pushes.
// A publish reaches only the processes holding sockets it concerns —
// that scoping is the entire point of the migration.
const (
	FleetControlSubject   = "fleet.control"
	FleetBroadcastSubject = "fleet.broadcast"
	AgentWildcardSubject  = "agent.*"
)

// SubjectForFanout maps a fanout envelope to its bus subject. Mirrors
// subjectForFanout in apps/gateway/src/ws/bus.ts exactly.
func SubjectForFanout(msg FanoutMessage) string {
	switch msg.Kind {
	case "agent":
		return "agent." + msg.AgentID
	case "console":
		return "console." + msg.OwnerID
	case "broadcast":
		if msg.RoomConversationID != "" {
			return "room." + msg.RoomConversationID
		}
		return FleetBroadcastSubject
	default: // "public"
		return FleetBroadcastSubject
	}
}

// UUIDv7 mints a time-ordered UUID (RFC 9562 version 7) with stdlib
// only: 48-bit unix milliseconds, version nibble 7, RFC variant, and
// the remaining 74 bits from crypto/rand. It stamps fanout `mid`s —
// the dual-run dedupe key (PHASE2_SPEC WI-2 step 2) — at parity with
// the TS side's @aiverse/shared/uuidv7. A crypto/rand failure degrades
// to time+counter entropy rather than failing the publish path: a mid
// only needs fleet-wide uniqueness, and a fanout publish must never
// fail on id generation.
var uuidv7FallbackCounter uint64

func UUIDv7() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		ms := uint64(time.Now().UnixMilli())
		for i := 0; i < 8; i++ {
			b[i] = byte(ms >> (56 - 8*i))
		}
		uuidv7FallbackCounter++
		c := uuidv7FallbackCounter * 0x9E3779B97F4A7C15
		for i := 0; i < 8; i++ {
			b[8+i] = byte(c >> (56 - 8*i))
		}
	}
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = (b[6] & 0x0f) | 0x70 // version 7
	b[8] = (b[8] & 0x3f) | 0x80 // RFC variant 10xx
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
