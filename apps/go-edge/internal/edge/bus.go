package edge

import (
	"context"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/nats-io/nats.go"

	"aiverse/go-edge/internal/verse"
)

// ── Bus migration (PHASE2_SPEC WI-2) ──────────────────────────────────
// The parity twin of apps/gateway/src/ws/bus.ts: same subject design
// (internal/verse/bus.go), same rollout modes via AIVERSE_BUS_MODE —
//   legacy (DEFAULT): today's behavior exactly, Redis ws:fanout only;
//   dual:   publish to both transports, subscribe to both, dedupe by
//           the envelope's mid so each socket sees each message once;
//   nats:   publish + subscribe NATS only (the legacy receive path
//           stays in the binary; rollback is an env flip, no deploy).
// The ingest stream, cursors, and presence keys are untouched — this
// moves the bus, not state.

const (
	busModeLegacy = "legacy"
	busModeDual   = "dual"
	busModeNATS   = "nats"
)

func parseBusMode(v string) string {
	if v == busModeDual || v == busModeNATS {
		return v
	}
	return busModeLegacy
}

const (
	busReconcileInterval = 500 * time.Millisecond
	busUnsubscribeGrace  = 30 * time.Second
	busControlSubject    = verse.FleetControlSubject
	busMidRingCapacity   = 256
)

// midDedupe is the bounded per-connection ring of already-delivered
// fanout mids for dual mode (parity with bus.ts MidDedupe). check
// returns true when the mid was already recorded — a duplicate to
// drop; first sight records it. An empty mid never dedupes.
type midDedupe struct {
	ring   [busMidRingCapacity]string
	seen   map[string]struct{}
	cursor int
}

func newMidDedupe() *midDedupe {
	return &midDedupe{seen: make(map[string]struct{})}
}

func (d *midDedupe) check(mid string) bool {
	if mid == "" {
		return false
	}
	if _, ok := d.seen[mid]; ok {
		return true
	}
	if evicted := d.ring[d.cursor]; evicted != "" {
		delete(d.seen, evicted)
	}
	d.ring[d.cursor] = mid
	d.seen[mid] = struct{}{}
	d.cursor = (d.cursor + 1) % busMidRingCapacity
	return false
}

// busState is the process's NATS transport: one connection, the
// believed-subscribed subject set (the reconciler's source of truth —
// actual subscription handles hang off it), and the unsubscribe-grace
// bookkeeping. Guarded by its own mutex; the registry it reads lives
// under Server.mu and is only walked by computeDesiredBusSubjects.
type busState struct {
	mu         sync.Mutex
	nc         *nats.Conn
	subscribed map[string]struct{}
	handles    map[string]*nats.Subscription
	absent     map[string]time.Time
	desired    map[string]struct{}
}

func newBusState() *busState {
	return &busState{
		subscribed: make(map[string]struct{}),
		handles:    make(map[string]*nats.Subscription),
		absent:     make(map[string]time.Time),
		desired:    make(map[string]struct{}),
	}
}

func busNodeName() string {
	if v := os.Getenv("AIVERSE_BUS_NODE_NAME"); v != "" {
		return v
	}
	return "go-edge-" + strconv.Itoa(os.Getpid())
}

func busURL() string {
	if v := os.Getenv("NATS_URL"); v != "" {
		return v
	}
	return nats.DefaultURL
}

// startBus connects the NATS transport and runs the subscription
// reconciler for the life of ctx. No-op in legacy mode. The connect
// loop retries forever in the background: the edge must boot and serve
// legacy traffic while NATS is down — in dual mode a down bus costs
// nothing (Redis carries); in nats mode it is a routing pause, never a
// loss (the backlog is the durable truth).
func (s *Server) startBus(ctx context.Context) {
	if s.busMode == busModeLegacy || s.bus == nil {
		return
	}
	go s.busConnectLoop(ctx)
	go func() {
		t := time.NewTicker(busReconcileInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				s.reconcileBusSubscriptions(now)
			}
		}
	}()
}

func (s *Server) busConnectLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		nc, err := nats.Connect(busURL(),
			nats.Name(busNodeName()),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(time.Second),
			nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
				if err != nil {
					s.logger.Printf("bus_disconnected err=%v", err)
				}
			}),
			nats.ClosedHandler(func(_ *nats.Conn) {
				s.bus.mu.Lock()
				if s.bus.nc != nil {
					s.bus.nc = nil
				}
				s.bus.mu.Unlock()
			}),
		)
		if err != nil {
			s.logger.Printf("bus_connect_error err=%v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}
		s.bus.mu.Lock()
		s.bus.nc = nc
		// (Re)apply the control subject plus whatever the reconciler
		// currently wants — it re-derives desired every tick, so this
		// snapshot is at most one interval stale.
		s.busEnsureSubLocked(busControlSubject)
		for subject := range s.bus.desired {
			s.busEnsureSubLocked(subject)
		}
		s.bus.mu.Unlock()
		s.logger.Printf("bus_connected url=%s name=%s", busURL(), busNodeName())
		select {
		case <-ctx.Done():
			nc.Close()
			return
		case <-nc.StatusChanged(nats.CLOSED):
		}
		// Permanently closed (not a server outage — nats.go reconnects
		// those internally forever): loop and try to connect again.
		s.bus.mu.Lock()
		s.bus.nc = nil
		s.bus.mu.Unlock()
	}
}

// busEnsureSubLocked records subject as believed-subscribed and
// creates the real subscription when a connection exists. Caller
// holds bus.mu.
func (s *Server) busEnsureSubLocked(subject string) {
	if _, ok := s.bus.subscribed[subject]; ok {
		return
	}
	s.bus.subscribed[subject] = struct{}{}
	if s.bus.nc == nil {
		return
	}
	sub, err := s.bus.nc.Subscribe(subject, func(m *nats.Msg) {
		s.deliverFanout(string(m.Data))
	})
	if err != nil {
		s.logger.Printf("bus_subscribe_error subject=%s err=%v", subject, err)
		delete(s.bus.subscribed, subject)
		return
	}
	s.bus.handles[subject] = sub
}

// busUnsubLocked drops a subscription (reconciler, after the grace).
// Caller holds bus.mu.
func (s *Server) busUnsubLocked(subject string) {
	delete(s.bus.subscribed, subject)
	if sub, ok := s.bus.handles[subject]; ok {
		_ = sub.Unsubscribe()
		delete(s.bus.handles, subject)
	}
}

// publishBusMessage is the fire-and-forget bus publish half of
// PublishFanout: a missing connection is silent in dual (the Redis
// copy already went out) and loud in nats mode (it was the only copy).
func (s *Server) publishBusMessage(subject string, raw []byte) {
	if s.bus == nil {
		return
	}
	s.bus.mu.Lock()
	nc := s.bus.nc
	s.bus.mu.Unlock()
	if nc == nil {
		if s.busMode == busModeNATS {
			s.logger.Printf("bus_publish_no_connection subject=%s", subject)
		}
		return
	}
	if err := nc.Publish(subject, raw); err != nil {
		s.logger.Printf("bus_publish_error subject=%s err=%v", subject, err)
	}
}

// computeDesiredBusSubjects derives the subscription set from the
// registries (WI-2 step 4): a room subject per locally-held room, the
// agent wildcard + fleet.broadcast while any agent socket is held,
// fleet.broadcast while any public socket is held, and one console
// subject per owner with a local console socket.
func (s *Server) computeDesiredBusSubjects() map[string]struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	desired := make(map[string]struct{})
	if len(s.agents) > 0 {
		desired[verse.AgentWildcardSubject] = struct{}{}
		desired[verse.FleetBroadcastSubject] = struct{}{}
	}
	if len(s.publics) > 0 {
		desired[verse.FleetBroadcastSubject] = struct{}{}
	}
	for _, c := range s.agents {
		for roomID := range c.rooms {
			desired["room."+roomID] = struct{}{}
		}
	}
	for ownerID, set := range s.consoles {
		if len(set) > 0 {
			desired["console."+ownerID] = struct{}{}
		}
	}
	return desired
}

// reconcileBusSubscriptions matches believed subscriptions to the
// desired set: subscribes are immediate; unsubscribes wait out the
// 30 s grace (absent since first observed missing) so a reconnect flap
// never churns a subscription. fleet.control is exempt — it is held
// for the process's life.
func (s *Server) reconcileBusSubscriptions(now time.Time) {
	if s.bus == nil || s.busMode == busModeLegacy {
		return
	}
	desired := s.computeDesiredBusSubjects()
	s.bus.mu.Lock()
	defer s.bus.mu.Unlock()
	s.bus.desired = desired
	for subject := range desired {
		delete(s.bus.absent, subject)
		s.busEnsureSubLocked(subject)
	}
	candidates := make(map[string]struct{}, len(s.bus.subscribed)+len(s.bus.absent))
	for subject := range s.bus.subscribed {
		candidates[subject] = struct{}{}
	}
	for subject := range s.bus.absent {
		candidates[subject] = struct{}{}
	}
	for subject := range candidates {
		if subject == busControlSubject {
			continue
		}
		if _, ok := desired[subject]; ok {
			continue
		}
		since, ok := s.bus.absent[subject]
		if !ok {
			s.bus.absent[subject] = now
			continue
		}
		if now.Sub(since) >= busUnsubscribeGrace {
			s.busUnsubLocked(subject)
			delete(s.bus.absent, subject)
		}
	}
}

// fanoutDuplicate reports whether this fanout envelope (by mid) was
// already delivered to this connection in dual mode, recording it when
// not. Called with Server.mu held (deliverFanout's switch) — the
// per-connection ring needs no lock of its own.
func (s *Server) fanoutDuplicate(c *conn, mid string) bool {
	if s.busMode != busModeDual || mid == "" {
		return false
	}
	if c.midDedupe == nil {
		c.midDedupe = newMidDedupe()
	}
	return c.midDedupe.check(mid)
}
