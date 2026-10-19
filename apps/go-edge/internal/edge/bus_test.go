package edge

import (
	"fmt"
	"testing"
	"time"

	"aiverse/go-edge/internal/verse"
)

// PHASE2_SPEC WI-2 unit coverage for the edge-level bus pieces: mode
// parsing (legacy is the default and the fallback), the dual-run
// dedupe ring, the subscription discipline's desired-set derivation
// (step 4), and the 30 s unsubscribe grace bookkeeping. Live transport
// behavior (publish counts, dual exactly-once against real processes,
// cross-edge delivery) is integration-proven by the local fleet
// harness, not here — no test in this file opens a NATS connection.

func TestParseBusMode(t *testing.T) {
	if got := parseBusMode(""); got != busModeLegacy {
		t.Errorf("unset mode = %q, want legacy (prod deploys dark)", got)
	}
	if got := parseBusMode("dual"); got != busModeDual {
		t.Errorf("dual = %q", got)
	}
	if got := parseBusMode("nats"); got != busModeNATS {
		t.Errorf("nats = %q", got)
	}
	if got := parseBusMode("NATS"); got != busModeLegacy {
		t.Errorf("garbage mode = %q, want legacy fallback", got)
	}
}

func TestMidDedupe(t *testing.T) {
	d := newMidDedupe()
	if d.check("") {
		t.Error("empty mid must never dedupe (pre-WI-2 envelopes carry none)")
	}
	if d.check("m-1") {
		t.Error("first sight of m-1 must pass")
	}
	if !d.check("m-1") {
		t.Error("second sight of m-1 must be a duplicate")
	}
	if d.check("m-2") {
		t.Error("first sight of m-2 must pass")
	}
}

func TestMidDedupeRingEvicts(t *testing.T) {
	d := newMidDedupe()
	d.check("old")
	for i := 0; i < 300; i++ {
		d.check(fmt.Sprintf("filler-%d", i))
	}
	if d.check("old") {
		t.Error("an evicted mid must pass again (the ring is bounded)")
	}
	if !d.check("filler-299") {
		t.Error("a recent mid must still be remembered")
	}
}

func TestComputeDesiredBusSubjects(t *testing.T) {
	s := &Server{
		agents:   make(map[string]*conn),
		consoles: make(map[string]map[*conn]struct{}),
		publics:  make(map[*conn]struct{}),
	}
	if got := s.computeDesiredBusSubjects(); len(got) != 0 {
		t.Fatalf("empty registries: desired = %v, want none", got)
	}

	agentConn := &conn{rooms: map[string]struct{}{"room-a": {}, "room-b": {}}}
	s.agents["a-1"] = agentConn
	s.publics[&conn{}] = struct{}{}
	s.consoles["o-1"] = map[*conn]struct{}{&conn{}: {}}
	s.consoles["o-2"] = map[*conn]struct{}{} // empty set: no subject

	got := s.computeDesiredBusSubjects()
	want := map[string]struct{}{
		verse.AgentWildcardSubject:  {},
		verse.FleetBroadcastSubject: {},
		"room.room-a":               {},
		"room.room-b":               {},
		"console.o-1":               {},
	}
	if len(got) != len(want) {
		t.Fatalf("desired = %v, want %v", got, want)
	}
	for subject := range want {
		if _, ok := got[subject]; !ok {
			t.Errorf("desired missing %q (got %v)", subject, got)
		}
	}
}

func TestReconcileUnsubscribeGrace(t *testing.T) {
	s := &Server{
		busMode:  busModeDual,
		bus:      newBusState(),
		agents:   make(map[string]*conn),
		consoles: make(map[string]map[*conn]struct{}),
		publics:  make(map[*conn]struct{}),
	}
	subject := "room.gone"
	// A subscription exists (believed) for a room nobody holds anymore.
	s.bus.subscribed[subject] = struct{}{}
	s.bus.subscribed[busControlSubject] = struct{}{}

	t0 := time.Unix(1_700_000_000, 0)
	s.reconcileBusSubscriptions(t0)
	if _, ok := s.bus.subscribed[subject]; !ok {
		t.Fatal("subject unsubscribed immediately — the grace must absorb flaps")
	}
	s.reconcileBusSubscriptions(t0.Add(busUnsubscribeGrace - time.Second))
	if _, ok := s.bus.subscribed[subject]; !ok {
		t.Fatal("subject unsubscribed before the 30 s grace elapsed")
	}
	s.reconcileBusSubscriptions(t0.Add(busUnsubscribeGrace + time.Second))
	if _, ok := s.bus.subscribed[subject]; ok {
		t.Fatal("subject still subscribed after the grace elapsed")
	}
	// fleet.control is exempt from reconciliation — held for life.
	if _, ok := s.bus.subscribed[busControlSubject]; !ok {
		t.Fatal("fleet.control must never be reconciled away")
	}
}

func TestReconcileSubscribesDesiredImmediately(t *testing.T) {
	s := &Server{
		busMode:  busModeDual,
		bus:      newBusState(),
		agents:   make(map[string]*conn),
		consoles: make(map[string]map[*conn]struct{}),
		publics:  make(map[*conn]struct{}),
	}
	s.agents["a-1"] = &conn{rooms: map[string]struct{}{"room-x": {}}}
	s.reconcileBusSubscriptions(time.Unix(1_700_000_000, 0))
	for _, subject := range []string{"room.room-x", verse.AgentWildcardSubject, verse.FleetBroadcastSubject} {
		if _, ok := s.bus.subscribed[subject]; !ok {
			t.Errorf("desired subject %q not believed-subscribed after reconcile", subject)
		}
	}
	// And a room that comes back inside the grace keeps its
	// subscription: remove, tick, restore, tick — still subscribed.
	delete(s.agents, "a-1")
	s.reconcileBusSubscriptions(time.Unix(1_700_000_100, 0))
	s.agents["a-1"] = &conn{rooms: map[string]struct{}{"room-x": {}}}
	s.reconcileBusSubscriptions(time.Unix(1_700_000_110, 0))
	if _, ok := s.bus.subscribed["room.room-x"]; !ok {
		t.Error("room.room-x lost its subscription across a within-grace flap")
	}
	if _, ok := s.bus.absent["room.room-x"]; ok {
		t.Error("a restored subject must leave the absent bookkeeping")
	}
}
