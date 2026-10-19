package verse

import (
	"regexp"
	"testing"
)

// PHASE2_SPEC WI-2 unit coverage for the verse-level bus pieces: the
// uuidv7 mid format and the subject design (step 1). The TS twin is
// apps/gateway/src/ws/bus.test.ts — the two must agree exactly.

var uuidv7Re = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestUUIDv7Shape(t *testing.T) {
	id := UUIDv7()
	if !uuidv7Re.MatchString(id) {
		t.Fatalf("UUIDv7() = %q, want a uuidv7 (version 7, RFC variant)", id)
	}
}

func TestUUIDv7UniqueAndOrdered(t *testing.T) {
	a, b := UUIDv7(), UUIDv7()
	if a == b {
		t.Fatalf("two UUIDv7() calls collided: %q", a)
	}
	// Time-ordered: the 48-bit ms prefix must be non-decreasing across
	// calls (string order on the prefix tracks it).
	if a[:13] > b[:13] {
		t.Fatalf("UUIDv7 prefixes out of order: %q then %q", a, b)
	}
}

func TestSubjectForFanout(t *testing.T) {
	cases := []struct {
		name string
		msg  FanoutMessage
		want string
	}{
		{"agent direct", FanoutMessage{Kind: "agent", AgentID: "a-1"}, "agent.a-1"},
		{"room broadcast", FanoutMessage{Kind: "broadcast", RoomConversationID: "c-9"}, "room.c-9"},
		{"fleet broadcast", FanoutMessage{Kind: "broadcast"}, FleetBroadcastSubject},
		{"public", FanoutMessage{Kind: "public"}, FleetBroadcastSubject},
		{"console", FanoutMessage{Kind: "console", OwnerID: "o-7"}, "console.o-7"},
	}
	for _, tc := range cases {
		if got := SubjectForFanout(tc.msg); got != tc.want {
			t.Errorf("%s: SubjectForFanout = %q, want %q", tc.name, got, tc.want)
		}
	}
	if FleetControlSubject != "fleet.control" {
		t.Errorf("FleetControlSubject = %q, want fleet.control", FleetControlSubject)
	}
	if AgentWildcardSubject != "agent.*" {
		t.Errorf("AgentWildcardSubject = %q, want agent.*", AgentWildcardSubject)
	}
}
