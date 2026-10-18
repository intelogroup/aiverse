// Package edge is the Go WebSocket edge at PARITY with the TypeScript
// gateway's ws layer (apps/gateway/src/ws/gateway.ts, ws/events.ts,
// presence.ts, policy/visits.ts). Same routes, same Redis + Postgres
// contracts, same close codes, same backlog — and it PUBLISHES the
// ws:fanout events it originates, so a mixed TS+Go deployment interoperates.
//
// Two deliberate deviations from TS behavior:
//   - Register-first connect (PARITY_SPEC §2): the new socket enters the
//     local fanout map BEFORE the DB status write, in a "setting-up" state
//     with a bounded pending buffer, so fanout deliveries during connect
//     setup are buffered and flushed after the backlog instead of being
//     lost to registration lag (the TS path's measured 15.7s worst case in
//     BENCH_RESULTS.md).
//   - Presence digests (FANOUT_FIX_SPEC, amending PARITY_SPEC §2/§8): this
//     edge's own agent_joined/agent_left events are collected, netted, and
//     published as batched presence_digest broadcasts instead of one
//     fanout blast per event — the per-join blast is O(n²) socket writes
//     and drowned message delivery in the 5k soak.
//
// Everything else follows the TS source; where they once differed in the
// spike (stash-only acks, no connect gates, a pong reply to client ping
// envelopes the TS gateway ignores), parity won.
package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/verse"
)

// Close codes (ws/gateway.ts).
const (
	CloseInvalidTicket    = 4001
	CloseHeartbeatTimeout = 4002
	CloseAgentPaused      = 4003
	CloseAgentUnclaimed   = 4005
	CloseReplaced         = 4006
	CloseVisitEnded       = 4008
	// CloseReconnectBudget (4009): the per-agent reconnect budget
	// (PHASE0_SPEC §2) is spent; the close reason carries the
	// {"retry_after_ms":…} hint.
	CloseReconnectBudget = 4009
)

const defaultHeartbeatInterval = 30 * time.Second
const sendQueueSize = 1024

// Presence digest flush triggers (FANOUT_FIX_SPEC): publish when the
// window elapses OR the pending count reaches the cap, whichever first.
const (
	defaultDigestWindow     = 1000 * time.Millisecond
	defaultDigestMaxPending = 250
)

// Bounded pending buffer for a setting-up conn (spec §2 step 6): fanout
// deliveries during connect setup append here, never to the socket.
const maxPendingBuffer = 1024

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func nowMs() int64 { return time.Now().UnixMilli() }

// Originated-event payloads, as structs so the JSON key order matches the
// TS object literals in ws/gateway.ts exactly.
type agentConnectedPayload struct {
	AgentID string `json:"agent_id"`
}
type agentJoinedPayload struct {
	AgentID      string   `json:"agent_id"`
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
}
type agentLeftPayload struct {
	AgentID string `json:"agent_id"`
}
type agentStatusChangedPayload struct {
	AgentID string `json:"agent_id"`
	Status  string `json:"status"`
}

// presenceDigestPayload is the FANOUT-INTERNAL presence_digest
// envelope payload (FANOUT_FIX_SPEC + WI-3): the window's netted
// join/left sets in first-seen order, each entry carrying its subject's
// room-set snapshot, plus the oversize summaries when any attributed
// room is oversize. scopePresenceDigest strips the internal members
// before any socket write (see presencev2.go).
type presenceDigestPayload struct {
	Joined        []digestJoinedEntry `json:"joined"`
	Left          []digestLeftEntry   `json:"left"`
	Summaries     []presenceSummary   `json:"summaries,omitempty"`
	OversizeRooms []string            `json:"oversize_rooms,omitempty"`
}
type visitEndedPayload struct {
	AgentID string `json:"agent_id"`
	VisitID string `json:"visit_id"`
	Reason  string `json:"reason"`
}

// conn is one live socket of any flavor (agent / console / public). For
// agent conns the pointer itself is the connection generation: every
// handler identity-checks `srv.agents[agentID] == c`, the Go equivalent of
// TS's `conn.ws.raw === ws.raw` comparison.
type conn struct {
	ws      *websocket.Conn
	kind    string // "agent" | "console" | "public"
	agentID string
	ownerID string

	// agent conns: identity captured at connect for fanout publishes and
	// the disconnect path.
	name         string
	capabilities []string

	// rooms is the connection's WI-3 room set: the conversation ids
	// this agent participates in, populated from the participant rows
	// at the live transition and maintained by the fanout path
	// (conversation_started deliveries, room-scoped join broadcasts).
	// Guarded by Server.mu, like the registry itself. Process-local
	// and best-effort by design — Postgres participant rows remain the
	// truth and the set is rebuilt from them on every connect.
	rooms map[string]struct{}

	sendCh  chan []byte
	done    chan struct{}
	dropped atomic.Int64

	missedPings atomic.Int32

	// Register-first setup state (guarded by Server.mu): while settingUp,
	// fanout deliveries append to pending instead of the socket. live is
	// set by flushPending at the live transition: a connection that never
	// went live never announced a join, so its disconnect must not
	// announce a leave either (ws/gateway.ts onClose's wasLive).
	settingUp bool
	live      bool
	pending   [][]byte
}

func (c *conn) enqueue(payload []byte) bool {
	select {
	case c.sendCh <- payload:
		return true
	default:
		c.dropped.Add(1)
		return false
	}
}

func (c *conn) close(code websocket.StatusCode, reason string) {
	_ = c.ws.Close(code, reason)
}

// Server holds all live sockets for this process, the fanout subscriber,
// and the Postgres pool the parity paths read/write.
type Server struct {
	rdb    *redis.Client
	sub    *redis.Client
	pool   *pgxpool.Pool
	logger *log.Logger

	// jwtSecret verifies the agent + owner session JWTs the ws-ticket
	// mints authenticate with (wsticket.go) — env.JWT_SECRET on the TS
	// side, read from the environment in NewServer. Empty fails closed:
	// JWT verification always errors, so the owner mint refuses every
	// token and the agent mint serves only the legacy bearer path. A
	// field so tests can set it via startTestServerWith.
	jwtSecret string

	// heartbeatInterval is 30s in production (ws/gateway.ts); a field so
	// tests can run the 4002 path without waiting 90s.
	heartbeatInterval time.Duration
	// backlogDelay is a test hook: it stretches deliverBacklog so the
	// register-first proof can publish fanout mid-setup. Zero in prod.
	backlogDelay time.Duration

	// Presence digest collection (FANOUT_FIX_SPEC). digestWindow /
	// digestMaxPending are fields so tests can shrink the flush triggers.
	// digestOrder holds agent ids in first-seen order; each id sits in
	// exactly one of digestJoined / digestLeft (last-write-wins netting).
	digestWindow     time.Duration
	digestMaxPending int
	digestKick       chan struct{}
	digestMu         sync.Mutex
	digestJoined     map[string]digestJoinedEntry
	digestLeft       map[string]digestLeftEntry
	digestOrder      []string

	// WI-3 oversize determination cache (see presencev2.go): per-room,
	// TTL-bound, invalidated by every locally observed membership
	// change.
	oversizeMu    sync.Mutex
	oversizeCache map[string]oversizeDetermination

	// Connect admission (PHASE0_SPEC §2): per-process token bucket
	// guarding the TLS+auth CPU a connect storm burns before any ticket
	// is redeemed. Lazily initialized to the burst cap on first use,
	// re-clamped to the current cap on every check — the env knobs are
	// re-read per check, so a change takes effect without a restart.
	connectMu       sync.Mutex
	connectInit     bool
	connectTokens   float64
	connectLastMs   int64

	mu       sync.Mutex
	agents   map[string]*conn
	consoles map[string]map[*conn]struct{}
	publics  map[*conn]struct{}

	// stats for the bench/report
	Delivered atomic.Int64
	Dropped   atomic.Int64
}

func NewServer(rdb *redis.Client, pool *pgxpool.Pool, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		// The TS gateway refuses to boot without JWT_SECRET; the edge
		// can still serve ticket-based WS without it, so warn and let
		// the mints fail closed (wsticket.go) instead of dying here.
		logger.Printf("jwt_secret_unset: ws-ticket JWT auth fails closed until JWT_SECRET is set")
	}
	return &Server{
		rdb:               rdb,
		sub:               rdb,
		pool:              pool,
		logger:            logger,
		jwtSecret:         jwtSecret,
		heartbeatInterval: defaultHeartbeatInterval,
		digestWindow:      defaultDigestWindow,
		digestMaxPending:  defaultDigestMaxPending,
		digestKick:        make(chan struct{}, 1),
		digestJoined:      make(map[string]digestJoinedEntry),
		digestLeft:        make(map[string]digestLeftEntry),
		oversizeCache:     make(map[string]oversizeDetermination),
		agents:            make(map[string]*conn),
		consoles:          make(map[string]map[*conn]struct{}),
		publics:           make(map[*conn]struct{}),
	}
}

// ConnCount reports the number of live sockets across all three
// registries (agents hold one conn each; consoles and publics are
// sets). It exists for the periodic heap stats line in cmd/edge: heap
// per connection is the Phase 2 per-node budget metric, so the two
// numbers must be readable together.
func (s *Server) ConnCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.agents) + len(s.publics)
	for _, set := range s.consoles {
		n += len(set)
	}
	return n
}

// Handler returns the HTTP routes: /agents/ws, /console/ws, /public/ws,
// /healthz, and the ticket mints POST /auth/ws-ticket +
// POST /owners/ws-ticket (wsticket.go).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/agents/ws", s.handleAgentWS)
	mux.HandleFunc("/console/ws", s.handleConsoleWS)
	mux.HandleFunc("/public/ws", s.handlePublicWS)
	mux.HandleFunc("POST /auth/ws-ticket", s.handleAgentWSTicket)
	mux.HandleFunc("POST /owners/ws-ticket", s.handleOwnerWSTicket)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

// StartFanout subscribes this process to ws:fanout and delivers until ctx ends.
func (s *Server) StartFanout(ctx context.Context) {
	s.startPresenceDigest(ctx)
	sub := s.sub.Subscribe(ctx, verse.FanoutChannel)
	ch := sub.Channel(redis.WithChannelSize(4096))
	go func() {
		defer sub.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				s.deliverFanout(msg.Payload)
			}
		}
	}()
}

// PublishFanout is the publish half of the interop contract — the events
// this process originates (status/visit-ended directly; presence via the
// digest collector below) go out in the exact shapes the TS gateway
// publishes.
func (s *Server) PublishFanout(ctx context.Context, msg verse.FanoutMessage) {
	raw, err := json.Marshal(msg)
	if err != nil {
		return
	}
	if err := s.rdb.Publish(ctx, verse.FanoutChannel, raw).Err(); err != nil {
		s.logger.Printf("ws_fanout_publish_error kind=%s err=%v", msg.Kind, err)
	}
}

// ── presence digests (FANOUT_FIX_SPEC) ──────────────────────────────────
//
// This edge's own join/left events collect into a pending buffer with
// last-write-wins netting per agent, and flush as ONE presence_digest
// broadcast — replacing the per-event agent_joined/agent_left blasts,
// whose O(n²) socket writes drowned message delivery in the 5k soak.
// Presence truth stays in the Redis presence:* keys + DB status; the
// digest is advisory, like the frames it replaces.

// startPresenceDigest runs the flush loop for StartFanout's lifetime:
// flush when the window elapses or a size-cap kick lands.
func (s *Server) startPresenceDigest(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(s.digestWindow)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.flushPresenceDigest()
			case <-s.digestKick:
				s.flushPresenceDigest()
			}
		}
	}()
}

// recordPresenceJoined nets a join into the pending digest: any pending
// left for the agent is superseded. `rooms` is the subject's room-set
// snapshot at collect time (WI-3 attribution — last-write-wins, like
// the entry itself). The published console status event is unaffected
// (still per-event, owner-scoped).
func (s *Server) recordPresenceJoined(agentID, name string, capabilities []string, rooms []string) {
	if capabilities == nil {
		capabilities = []string{}
	}
	if rooms == nil {
		rooms = []string{}
	}
	// Active membership moved in every room the subject belongs to —
	// cached oversize determinations for those rooms are stale.
	for _, roomID := range rooms {
		s.invalidateOversizeDetermination(roomID)
	}
	s.digestMu.Lock()
	if _, inLeft := s.digestLeft[agentID]; inLeft {
		delete(s.digestLeft, agentID)
	} else if _, inJoined := s.digestJoined[agentID]; !inJoined {
		s.digestOrder = append(s.digestOrder, agentID)
	}
	s.digestJoined[agentID] = digestJoinedEntry{
		AgentID:      agentID,
		Name:         name,
		Capabilities: capabilities,
		Rooms:        rooms,
	}
	full := len(s.digestOrder) >= s.digestMaxPending
	s.digestMu.Unlock()
	if full {
		s.kickDigestFlush()
	}
}

// recordPresenceLeft nets a departure into the pending digest: any
// pending join for the agent is superseded.
func (s *Server) recordPresenceLeft(agentID string, rooms []string) {
	if rooms == nil {
		rooms = []string{}
	}
	// Active membership moved in every room the subject belongs to —
	// cached oversize determinations for those rooms are stale.
	for _, roomID := range rooms {
		s.invalidateOversizeDetermination(roomID)
	}
	s.digestMu.Lock()
	if _, inJoined := s.digestJoined[agentID]; inJoined {
		delete(s.digestJoined, agentID)
	} else if _, inLeft := s.digestLeft[agentID]; !inLeft {
		s.digestOrder = append(s.digestOrder, agentID)
	}
	s.digestLeft[agentID] = digestLeftEntry{AgentID: agentID, Rooms: rooms}
	full := len(s.digestOrder) >= s.digestMaxPending
	s.digestMu.Unlock()
	if full {
		s.kickDigestFlush()
	}
}

func (s *Server) kickDigestFlush() {
	select {
	case s.digestKick <- struct{}{}:
	default: // a flush is already queued; it will see the current buffer
	}
}

// flushPresenceDigest publishes the pending set as one presence_digest
// broadcast, entries in first-seen order. Empty buffer → no publish.
// The pending set is snapshotted and cleared first; WI-3 oversize
// determinations are resolved (from the per-room cache, computed on a
// miss) before the publish, so entries collected during the resolution
// land in the next window — netting and ordering semantics unchanged.
func (s *Server) flushPresenceDigest() {
	s.digestMu.Lock()
	if len(s.digestOrder) == 0 {
		s.digestMu.Unlock()
		return
	}
	joined := make([]digestJoinedEntry, 0, len(s.digestOrder))
	left := make([]digestLeftEntry, 0, len(s.digestOrder))
	for _, agentID := range s.digestOrder {
		if entry, ok := s.digestJoined[agentID]; ok {
			joined = append(joined, entry)
		} else if entry, ok := s.digestLeft[agentID]; ok {
			left = append(left, entry)
		}
	}
	s.digestJoined = make(map[string]digestJoinedEntry)
	s.digestLeft = make(map[string]digestLeftEntry)
	s.digestOrder = nil
	s.digestMu.Unlock()

	// Oversize rooms (WI-3 change 3): a room whose active membership
	// exceeds the threshold stops enumerating — its attributable
	// entries collapse into one presence_summary per room, built here;
	// delivery (scopePresenceDigest) suppresses the individual entries
	// for that room's members and delivers the summary instead.
	// Sub-threshold rooms in the same flush still enumerate.
	summaries, oversizeRooms := s.resolveOversizeSummaries(joined, left)

	s.PublishFanout(context.Background(), verse.FanoutMessage{
		Kind: "broadcast",
		Event: verse.NewEnvelope(verse.EventPresenceDigest, presenceDigestPayload{
			Joined:        joined,
			Left:          left,
			Summaries:     summaries,
			OversizeRooms: oversizeRooms,
		}).Bytes(),
	})
}

func (s *Server) deliverFanout(raw string) {
	var msg verse.FanoutMessage
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		return
	}
	event := []byte(msg.Event)
	var probe struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(msg.Event, &probe)
	isDigest := probe.Type == verse.EventPresenceDigest
	// WI-2 (PHASE1_SPEC): a passive participant receives mentions and
	// control frames but NOT message frames — suppressed messages
	// never advance the delivery cursor and replay from the backlog on
	// the next connect (the backlog itself does not skip passive
	// participants; WI-2 is live-delivery semantics only). TS applies
	// the skip publish-side (sendMessageService reads the participant
	// rows once per send); the Go edge applies the SAME data (a PG
	// point read of conversation_participants.mode) at delivery time,
	// outside s.mu so a slow read never stalls the fanout loop. The
	// source of truth is identical, and reading at delivery narrows —
	// never widens — the staleness window relative to TS. Only an
	// explicit 'passive' suppresses: no row / read error delivers.
	if msg.Kind == "agent" && probe.Type == verse.EventMessage && s.pool != nil {
		var mp struct {
			Payload struct {
				ConversationID string `json:"conversation_id"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg.Event, &mp); err == nil && mp.Payload.ConversationID != "" {
			if participantMode(context.Background(), s.pool, mp.Payload.ConversationID, msg.AgentID) == "passive" {
				return
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch msg.Kind {
	case "agent":
		if c := s.agents[msg.AgentID]; c != nil {
			// Presence v2 (WI-3) room-set maintenance: a
			// CONVERSATION_STARTED delivery means the recipient just
			// became a participant of that conversation — record it
			// so presence scoping and room-scoped broadcasts see the
			// membership without waiting for a reconnect.
			if probe.Type == verse.EventConversationStarted {
				var cp struct {
					Payload struct {
						ConversationID string `json:"conversation_id"`
					} `json:"payload"`
				}
				if err := json.Unmarshal(msg.Event, &cp); err == nil && cp.Payload.ConversationID != "" {
					addRoomLocked(c, cp.Payload.ConversationID)
				}
			}
			s.deliverTo(c, event)
		}
	case "broadcast":
		// Presence v2 (WI-3) room-set maintenance: a room-scoped
		// THREAD_PARTICIPANT_JOINED broadcast tells every process the
		// subject joined the conversation — heal the subject's local
		// room set BEFORE the scope filter runs, so an invitee whose
		// socket lives on this process (while the invite route ran on
		// another) passes the filter for their own join frame.
		if msg.RoomConversationID != "" && probe.Type == verse.EventThreadParticipantJoin {
			var jp struct {
				Payload struct {
					AgentID string `json:"agent_id"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(msg.Event, &jp); err == nil && jp.Payload.AgentID != "" {
				if sc := s.agents[jp.Payload.AgentID]; sc != nil {
					addRoomLocked(sc, msg.RoomConversationID)
				}
			}
			// The room's participant rows changed on whichever process
			// served the join/invite: drop any cached oversize
			// determination for it.
			s.invalidateOversizeDetermination(msg.RoomConversationID)
		}
		for agentID, c := range s.agents {
			if agentID == msg.ExceptAgentID {
				continue
			}
			// Room-scope filter: sockets outside the conversation
			// never see the frame. A filtered live frame is not a
			// correctness loss — the reconnect backlog replays missed
			// joins from the participant rows.
			if msg.RoomConversationID != "" {
				if _, member := c.rooms[msg.RoomConversationID]; !member {
					continue
				}
			}
			payload := event
			if isDigest {
				// FANOUT_FIX_SPEC + WI-3: a digest is scoped to room
				// co-members and stripped of the receiving socket's
				// own agent_id per receiver; skip the write entirely
				// when nothing remains for this socket.
				scoped, ok := scopePresenceDigest(event, agentID, c.rooms)
				if !ok {
					continue
				}
				payload = scoped
			}
			s.deliverTo(c, payload)
		}
	case "console":
		for c := range s.consoles[msg.OwnerID] {
			s.deliver(c, event)
		}
	case "public":
		for c := range s.publics {
			s.deliver(c, event)
		}
	}
}

// deliverTo routes a fanout payload to an agent conn: buffered while the
// conn is setting up (register-first), straight to the socket once live.
// Caller holds s.mu.
func (s *Server) deliverTo(c *conn, payload []byte) {
	if c.settingUp {
		if len(c.pending) < maxPendingBuffer {
			c.pending = append(c.pending, payload)
		} else {
			c.dropped.Add(1)
			s.Dropped.Add(1)
		}
		return
	}
	s.deliver(c, payload)
}

func (s *Server) deliver(c *conn, payload []byte) {
	if c.enqueue(payload) {
		s.Delivered.Add(1)
	} else {
		s.Dropped.Add(1)
	}
}

// ── connection lifecycle ────────────────────────────────────────────────

func (s *Server) runConn(ctx context.Context, c *conn, onFrame func(*conn, []byte), onDone func(*conn)) {
	// The socket's close is owned HERE, by the connection's root
	// goroutine, on EVERY exit path. Before this defer existed, the
	// read-error path (transport death: the peer's process dies, the
	// kernel sends a bare FIN, no WS close frame) broke the loop, ran
	// the registry cleanup — and never closed the socket: the writer
	// pump only closes on a write error, and the graceful close()
	// calls live in the heartbeat/replace/setup paths. net.Conn has
	// no finalizer, so each dead client leaked its fd with the kernel
	// socket parked in CLOSE_WAIT until the process hit the fd cap
	// and the accept loop wedged (8k soak, 2026-10-18: 3,791
	// CLOSE_WAIT). CloseNow is idempotent in coder/websocket, so the
	// closes other goroutines race in (heartbeat 4002, replaced 4006,
	// write-error CloseNow below) stay safe: they deliver their close
	// code while this goroutine is alive, and this defer guarantees
	// the fd is released when it exits.
	defer func() { _ = c.ws.CloseNow() }()
	// writer pump
	go func() {
		for {
			select {
			case <-c.done:
				return
			case payload := <-c.sendCh:
				wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.ws.Write(wctx, websocket.MessageText, payload)
				cancel()
				if err != nil {
					_ = c.ws.CloseNow()
					return
				}
			}
		}
	}()
	// reader loop (blocks)
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			break
		}
		if onFrame != nil {
			onFrame(c, data)
		}
	}
	close(c.done)
	if onDone != nil {
		onDone(c)
	}
}

func (s *Server) setPresence(ctx context.Context, agentID string) {
	_ = s.rdb.Set(ctx, verse.PresenceKey(agentID), "1", verse.PresenceTTLSeconds*time.Second).Err()
}

func (s *Server) clearPresence(ctx context.Context, agentID string) {
	_ = s.rdb.Del(ctx, verse.PresenceKey(agentID)).Err()
}

// ReconcilePresenceOnBoot is ws/gateway.ts's reconcilePresenceOnBoot: call
// once at process boot, before serving traffic.
func (s *Server) ReconcilePresenceOnBoot(ctx context.Context) (int, error) {
	if s.pool == nil {
		return 0, nil
	}
	return reconcilePresenceOnBoot(ctx, s.pool, func(agentID string) (bool, error) {
		n, err := s.rdb.Exists(ctx, verse.PresenceKey(agentID)).Result()
		return n == 1, err
	})
}

// forceDisconnectAgent mirrors ws/gateway.ts: close + de-register a live
// socket (the visit-ended side effect). Its onDone identity check then
// no-ops, exactly like the TS onClose guard.
func (s *Server) forceDisconnectAgent(agentID string, code int, reason string) bool {
	s.mu.Lock()
	c := s.agents[agentID]
	if c != nil {
		delete(s.agents, agentID)
	}
	s.mu.Unlock()
	if c == nil {
		return false
	}
	// Off the caller's goroutine: Close waits for the peer's handshake
	// echo, and a kicked socket may never read again (see handleAgentWS).
	go c.close(websocket.StatusCode(code), reason)
	return true
}

// announceVisitEnded is the one place for the visit-ended side effects
// (ws/gateway.ts): kick any live socket, leave a consoleEvents attention
// row, push visit_ended to the owner's console.
func (s *Server) announceVisitEnded(ctx context.Context, ended endedVisit) {
	s.forceDisconnectAgent(ended.AgentID, CloseVisitEnded, "visit ended: "+ended.Reason)
	if s.pool != nil {
		if err := insertConsoleEvent(ctx, s.pool, ended.AgentID, ended.OwnerID, "attention", visitEndedSummary(ended.Reason)); err != nil {
			s.logger.Printf("console_event_insert_error agentId=%s err=%v", ended.AgentID, err)
		}
	}
	s.PublishFanout(ctx, verse.FanoutMessage{
		Kind:    "console",
		OwnerID: ended.OwnerID,
		Event: verse.NewEnvelope(verse.EventVisitEnded, visitEndedPayload{
			AgentID: ended.AgentID,
			VisitID: ended.ID,
			Reason:  ended.Reason,
		}).Bytes(),
	})
	s.logger.Printf("visit_ended agentId=%s ownerId=%s visitId=%s reason=%s",
		ended.AgentID, ended.OwnerID, ended.ID, ended.Reason)
}

// ── Burst defenses (PHASE0_SPEC §2) ─────────────────────────────────────
// Two independent guards against connect storms, sized as seatbelts, not
// product limits — a port of the same section in ws/gateway.ts.

// Reconnect budget: per-agent fixed-window counter in Redis. On exceed,
// the connect is shed with close 4009 and a retry_after_ms hint (ms until
// the window resets) in the close reason — the server-driven retry hint
// that, with client-side jittered backoff, keeps a shed fleet from
// re-synchronizing into a second storm.
const (
	reconnectBudgetLimit         = 30
	reconnectBudgetWindowSeconds = 300
)

// consumeReconnectBudget spends one connect from the agent's window.
// Returns 0 when within budget, else the ms until the window resets.
func (s *Server) consumeReconnectBudget(ctx context.Context, agentID string) (int64, error) {
	key := verse.ReconnectBudgetKey(agentID)
	count, err := s.rdb.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if count == 1 {
		_ = s.rdb.Expire(ctx, key, reconnectBudgetWindowSeconds*time.Second).Err()
	}
	if count <= reconnectBudgetLimit {
		return 0, nil
	}
	pttl, err := s.rdb.PTTL(ctx, key).Result()
	if err != nil || pttl <= 0 {
		return reconnectBudgetWindowSeconds * 1000, nil
	}
	return pttl.Milliseconds(), nil
}

// Connect admission: a per-process token bucket. 200/s sustained, 400
// burst by default; env-tunable with the production values as defaults.
// The bucket re-clamps to the current cap on every check, so an env
// change takes effect on the next connect without a restart.
func connectRatePerSec() float64 {
	v, ok := os.LookupEnv("AIVERSE_WS_CONNECT_RATE_PER_SEC")
	if !ok {
		return 200
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if v == "" {
		f, err = 0, nil // JS Number("") === 0
	}
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 200
	}
	return f
}

func connectBurstAllowance() float64 {
	v, ok := os.LookupEnv("AIVERSE_WS_CONNECT_BURST")
	if !ok {
		return 400
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 1 {
		return 400
	}
	return math.Floor(f)
}

func (s *Server) tryAdmitAgentConnect() bool {
	cap := connectBurstAllowance()
	now := nowMs()
	s.connectMu.Lock()
	defer s.connectMu.Unlock()
	if !s.connectInit {
		s.connectTokens = cap
		s.connectLastMs = now
		s.connectInit = true
	}
	s.connectTokens = math.Min(cap,
		s.connectTokens+float64(now-s.connectLastMs)/1000.0*connectRatePerSec())
	s.connectLastMs = now
	if s.connectTokens >= 1 {
		s.connectTokens--
		return true
	}
	return false
}

// failSetup refuses a still-setting-up connection (ws/gateway.ts): the
// conn is unregistered (its pending buffer discarded unsent) and closed
// with the refusal's code. Nothing was delivered, no presence key was
// written, no digest join collected — no residue. The displaced incumbent
// is restored for refusals that say nothing about the incumbent (budget,
// missing row, the 4003/4005 agent-state gates: it is the same agent in
// the same state, and before register-first it was never touched); for a
// visit-ended refusal (restoreDisplaced=false) there is no restore — the
// visit is over for the incumbent too, so it is closed with the same code.
func (s *Server) failSetup(c *conn, displaced *conn, code int, reason string, restoreDisplaced bool) {
	var departed *conn
	var departedRooms []string
	s.mu.Lock()
	if s.agents[c.agentID] == c {
		delete(s.agents, c.agentID)
		c.pending = nil
		if displaced != nil && restoreDisplaced {
			// Restore only a socket proven open. TS checks
			// displaced.ws.raw?.readyState === 1; the Go signal is the
			// conn's done channel, closed by runConn when the socket's
			// read loop ended.
			select {
			case <-displaced.done:
				departed = displaced
				departedRooms = sortedRoomList(displaced.rooms)
			default:
				s.agents[c.agentID] = displaced
			}
		}
	}
	s.mu.Unlock()
	if departed != nil {
		// The incumbent died inside the setup window; its disconnect
		// cleanup identity-failed against this registration, so its
		// departure was never announced. Announce the leave and drop its
		// presence key here; the DB status write is left to the boot
		// reconciler (bounded, self-healing).
		s.recordPresenceLeft(c.agentID, departedRooms)
		s.clearPresence(context.Background(), c.agentID)
	}
	if displaced != nil && !restoreDisplaced {
		go displaced.close(websocket.StatusCode(code), reason)
	}
	c.close(websocket.StatusCode(code), reason)
}

func (s *Server) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	// Connect admission, ahead of the upgrade (PHASE0_SPEC §2):
	// returning here ends the chain, so a shed connect costs one token
	// check — no upgrade, no ticket redemption, no DB work. Existing
	// connections are never touched by shedding.
	if !s.tryAdmitAgentConnect() {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("too many connection attempts"))
		return
	}
	ctx := r.Context()
	bg := context.Background()
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	closeWith := func(code int, reason string) {
		ws.Close(websocket.StatusCode(code), reason)
	}
	if s.pool == nil {
		// No Postgres → no gate can pass; the pre-restructure handler
		// closed 4001 without a pool too (defensive; prod always has one).
		closeWith(CloseInvalidTicket, "invalid ticket")
		return
	}

	// Ticket-only auth: one-time, redeemed via GETDEL (AGENTS.md rule
	// 12); the legacy ?token= path is retired — a long-lived credential
	// must never appear in a query string / access log.
	ticket := r.URL.Query().Get("ticket")
	var ticketAgentID string
	if ticket != "" {
		if id, err := s.rdb.GetDel(ctx, verse.AgentTicketKey(ticket)).Result(); err == nil {
			ticketAgentID = id
		}
	}
	if ticketAgentID == "" {
		closeWith(CloseInvalidTicket, "invalid ticket")
		return
	}

	// Register-first (PHASE0_SPEC §1): this socket joins the fanout
	// registry NOW, in setting-up state — the GETDEL above is the only
	// blocking call in front of registration. Fanout frames that arrive
	// during setup buffer on the connection record (bounded:
	// maxPendingBuffer) and flush after the backlog instead of being
	// lost to registration lag. An incumbent connection for the same
	// agent is displaced from the registry by this registration — it
	// stops receiving fanout immediately — but it is only CLOSED (4006)
	// at the replace step after the gates pass: a refusal restores it
	// untouched (see failSetup).
	c := &conn{
		ws:        ws,
		kind:      "agent",
		agentID:   ticketAgentID,
		sendCh:    make(chan []byte, sendQueueSize),
		done:      make(chan struct{}),
		settingUp: true,
	}
	s.mu.Lock()
	displaced := s.agents[ticketAgentID]
	if displaced != nil {
		delete(s.agents, ticketAgentID)
	}
	s.agents[ticketAgentID] = c
	s.mu.Unlock()

	// The socket's pumps start at registration, as in TS, where the
	// socket's event handlers are live from onOpen: frames arriving
	// during setup are processed (pong/ack), and a peer close during
	// setup is observed by the identity-guarded disconnect path. The
	// context is Background, not the request's — the pump outlives this
	// handler and its lifetime is the socket's.
	go s.runConn(bg, c, s.onAgentFrame, s.onAgentDisconnect)

	// Burst defense (PHASE0_SPEC §2): the per-agent reconnect budget is
	// spent before any DB work — a storming agent costs one Redis INCR
	// per attempt from here on. The socket is already registered, so a
	// budget refusal flows through the same unregister + restore path
	// as a gate failure; the close code and reason are unchanged.
	retryAfterMs, err := s.consumeReconnectBudget(bg, ticketAgentID)
	if err != nil {
		// TS lets this throw out of onOpen — the socket dies and its
		// close handler runs the identity-guarded cleanup. CloseNow is
		// the Go equivalent; runConn's disconnect path does the rest.
		s.logger.Printf("reconnect_budget_error agentId=%s err=%v", ticketAgentID, err)
		_ = ws.CloseNow()
		return
	}
	if retryAfterMs > 0 {
		s.logger.Printf("ws_reconnect_budget_exceeded agentId=%s retryAfterMs=%d", ticketAgentID, retryAfterMs)
		s.failSetup(c, displaced, CloseReconnectBudget,
			fmt.Sprintf(`{"retry_after_ms":%d}`, retryAfterMs), true)
		return
	}

	agent, err := loadAgent(ctx, s.pool, ticketAgentID)
	if err != nil {
		s.logger.Printf("agent_load_error agentId=%s err=%v", ticketAgentID, err)
		_ = ws.CloseNow()
		return
	}
	if agent == nil {
		s.failSetup(c, displaced, CloseInvalidTicket, "invalid ticket", true)
		return
	}
	s.logger.Printf("agent_auth agentId=%s authMethod=ws_ticket", agent.ID)

	// Complete the registry record with the row's identity fields now
	// that the fetch has landed (nothing read them while setting up —
	// fanout delivery only buffers raw frames).
	if agent.OwnerID != nil {
		c.ownerID = *agent.OwnerID
	}
	c.name = agent.Name
	c.capabilities = agent.Capabilities

	// Gates 4003/4005: agent-state refusals restore the incumbent.
	if agent.Status == "paused" {
		s.failSetup(c, displaced, CloseAgentPaused, "agent paused", true)
		return
	}
	if agent.OwnerID == nil {
		s.failSetup(c, displaced, CloseAgentUnclaimed, "agent unclaimed", true)
		return
	}
	// Gate 4008 — visit: "GET" checks without consuming; an agent whose
	// visit already ended (deadline or cap, possibly not yet swept) must
	// not open a fresh socket. Announcing first if THIS call ended it.
	visit, err := checkAndConsumeVisit(ctx, s.pool, agent.ID, "GET", nowMs())
	if err != nil {
		s.logger.Printf("visit_check_error agentId=%s err=%v", agent.ID, err)
		_ = ws.CloseNow()
		return
	}
	if !visit.Allowed {
		if visit.Ended != nil {
			s.announceVisitEnded(bg, *visit.Ended)
		}
		s.failSetup(c, displaced, CloseVisitEnded, "visit ended", false)
		return
	}

	// A force-disconnect (the visit sweep kicking this agent) may have
	// unregistered this socket while the gates ran — its close is
	// already handled there; don't resurrect it.
	s.mu.Lock()
	registered := s.agents[agent.ID] == c
	s.mu.Unlock()
	if !registered {
		return
	}

	// Replace semantics (4006): same agent identity, second connection —
	// never leave the old socket as a silent zombie. The old socket's
	// own disconnect path will still fire async; its identity check is
	// what stops it from clobbering this connection's state. The Close
	// runs off this goroutine: coder/websocket's Close completes a
	// handshake, and a peer that never reads would otherwise stall setup.
	if displaced != nil {
		go displaced.close(websocket.StatusCode(CloseReplaced),
			"replaced by a new connection for the same agent")
	}

	// Status write + presence TTL key (the live presence truth).
	if err := setAgentOnline(bg, s.pool, agent.ID); err != nil {
		s.logger.Printf("set_online_error agentId=%s err=%v", agent.ID, err)
	}
	s.setPresence(bg, agent.ID)

	// agent_connected is the first frame the client sees.
	c.enqueue(verse.NewEnvelope(verse.EventAgentConnected,
		agentConnectedPayload{AgentID: agent.ID}).Bytes())

	// Backlog, sent straight to the socket queue (fanout frames
	// arriving meanwhile stay buffered, so wire order is backlog-first).
	if s.backlogDelay > 0 {
		time.Sleep(s.backlogDelay)
	}

	// Presence v2 (WI-3): populate the connection's room set from the
	// participant rows — the anchor every later maintenance event only
	// has to keep current. This MUST stay ahead of the backlog +
	// pending-flush sequence below: flushPending and the live
	// transition after it run under s.mu with no blocking call between
	// them (a fanout frame delivered to this connection in such a gap
	// would land in the pending buffer after its only flush and never
	// reach the socket), so every blocking setup step belongs before
	// that sequence. Populated here, the set is still complete before
	// the live transition, so the digest join collected below snapshots
	// a complete set and room-scoped delivery applies from the first
	// live frame. (Mirrors the f323a93 comment in ws/gateway.ts; a read
	// failure logs and continues with an empty set, like the backlog
	// read below — TS throws out of onOpen instead. Error path only:
	// the set self-heals at the next connect and via fanout
	// maintenance.)
	if roomIDs, err := listAgentConversationIDs(bg, s.pool, agent.ID); err != nil {
		s.logger.Printf("rooms_populate_error agentId=%s err=%v", agent.ID, err)
	} else {
		s.mu.Lock()
		c.rooms = make(map[string]struct{}, len(roomIDs))
		for _, roomID := range roomIDs {
			c.rooms[roomID] = struct{}{}
		}
		s.mu.Unlock()
	}

	backlogStart := time.Now()
	counts, deliveredMsgIDs, err := s.deliverBacklog(bg, agent.ID, func(env verse.Envelope) {
		c.enqueue(env.Bytes())
	})
	if err != nil {
		s.logger.Printf("backlog_error agentId=%s err=%v", agent.ID, err)
		counts = backlogCounts{}
		deliveredMsgIDs = map[string]bool{}
	}
	s.logger.Printf("ws_connect agentId=%s ownerId=%s backlogMessages=%d backlogTasks=%d backlogMentions=%d backlogParticipantJoins=%d backlogMs=%d",
		agent.ID, c.ownerID, counts.Messages, counts.Tasks, counts.Mentions,
		counts.ParticipantJoins, time.Since(backlogStart).Milliseconds())

	// Flush the pending buffer (message envelopes already delivered in
	// the backlog are deduped), mark the conn live.
	s.flushPending(c, deliveredMsgIDs)

	// The socket may have closed mid-setup — its disconnect path
	// already ran its cleanup and unregistered it. Don't announce a
	// join (or start a heartbeat) for a connection that no longer exists.
	s.mu.Lock()
	registered = s.agents[agent.ID] == c
	s.mu.Unlock()
	if !registered {
		return
	}

	// Publish the originated fanout for mixed TS+Go interop: the join
	// nets into the presence digest (FANOUT_FIX_SPEC — no more per-join
	// broadcast blast), the status goes to the owner's console. The
	// digest join collects only now that the connection is live — a
	// gate-failed or never-completed setup never appears in a digest.
	s.recordPresenceJoined(agent.ID, agent.Name, agent.Capabilities, s.connRoomsSnapshot(c))
	s.PublishFanout(bg, verse.FanoutMessage{
		Kind:    "console",
		OwnerID: c.ownerID,
		Event: verse.NewEnvelope(verse.EventAgentStatusChanged, agentStatusChangedPayload{
			AgentID: agent.ID,
			Status:  "online",
		}).Bytes(),
	})

	go s.heartbeat(c)
}

// flushPending drains the setting-up buffer after the backlog: message
// envelopes whose message id was already delivered in the backlog are
// skipped; everything else flushes in arrival order. Marked live under
// the same lock so no fanout delivery can slip between buffer and socket.
func (s *Server) flushPending(c *conn, deliveredMsgIDs map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := c.pending
	c.pending = nil
	c.settingUp = false
	c.live = true
	for _, raw := range pending {
		if id, isMsg := messageEnvelopeID(raw); isMsg && deliveredMsgIDs[id] {
			continue
		}
		s.deliver(c, raw)
	}
}

// messageEnvelopeID extracts payload.message_id from a "message" envelope.
func messageEnvelopeID(raw []byte) (string, bool) {
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			MessageID string `json:"message_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || env.Type != verse.EventMessage {
		return "", false
	}
	if env.Payload.MessageID == "" {
		return "", false
	}
	return env.Payload.MessageID, true
}

// onAgentDisconnect is ws/gateway.ts's onClose, identity-guarded first: a
// replaced socket's cleanup is a no-op — the new conn owns presence now.
func (s *Server) onAgentDisconnect(c *conn) {
	s.mu.Lock()
	current := s.agents[c.agentID] == c
	if current {
		delete(s.agents, c.agentID)
	}
	wasLive := c.live
	// The departure's WI-3 attribution snapshot: the conn's room set at
	// close, taken under the same lock that unregisters it.
	rooms := sortedRoomList(c.rooms)
	s.mu.Unlock()
	if !current {
		return
	}
	bg := context.Background()
	s.clearPresence(bg, c.agentID)
	// Deliberate statuses (paused, budget_exhausted) survive the close —
	// the NOT IN guard lives in the SQL.
	if s.pool != nil {
		if err := setAgentOfflineOnClose(bg, s.pool, c.agentID); err != nil {
			s.logger.Printf("set_offline_error agentId=%s err=%v", c.agentID, err)
		}
	}
	// A connection that never went live never announced a join (the
	// digest join collects at the live transition), so it must not
	// announce a leave or an offline status either. Registry/presence/
	// status cleanup above still runs — setup may have written the
	// online transition already.
	if wasLive {
		// The departure nets into the presence digest (FANOUT_FIX_SPEC);
		// the console status push below stays per-event.
		s.recordPresenceLeft(c.agentID, rooms)
	}
	s.logger.Printf("ws_disconnect agentId=%s ownerId=%s dropped=%d", c.agentID, c.ownerID, c.dropped.Load())
	if wasLive && c.ownerID != "" {
		s.PublishFanout(bg, verse.FanoutMessage{
			Kind:    "console",
			OwnerID: c.ownerID,
			Event: verse.NewEnvelope(verse.EventAgentStatusChanged, agentStatusChangedPayload{
				AgentID: c.agentID,
				Status:  "offline",
			}).Bytes(),
		})
	}
}

func (s *Server) handleConsoleWS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ticket := r.URL.Query().Get("ticket")
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	// Ticket-only auth (POST /owners/ws-ticket), GETDEL like the agent one.
	ownerID, err := s.rdb.GetDel(ctx, verse.OwnerTicketKey(ticket)).Result()
	if err != nil || ownerID == "" {
		ws.Close(websocket.StatusCode(CloseInvalidTicket), "invalid ticket")
		return
	}
	c := &conn{
		ws:      ws,
		kind:    "console",
		ownerID: ownerID,
		sendCh:  make(chan []byte, sendQueueSize),
		done:    make(chan struct{}),
	}
	s.mu.Lock()
	set := s.consoles[ownerID]
	if set == nil {
		set = make(map[*conn]struct{})
		s.consoles[ownerID] = set
	}
	set[c] = struct{}{}
	s.mu.Unlock()

	s.runConn(ctx, c, nil, func(c *conn) {
		s.mu.Lock()
		if set := s.consoles[c.ownerID]; set != nil {
			delete(set, c)
			if len(set) == 0 {
				delete(s.consoles, c.ownerID)
			}
		}
		s.mu.Unlock()
	})
}

func (s *Server) handlePublicWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c := &conn{
		ws:     ws,
		kind:   "public",
		sendCh: make(chan []byte, sendQueueSize),
		done:   make(chan struct{}),
	}
	s.mu.Lock()
	s.publics[c] = struct{}{}
	s.mu.Unlock()

	s.runConn(r.Context(), c, nil, func(c *conn) {
		s.mu.Lock()
		delete(s.publics, c)
		s.mu.Unlock()
	})
}

// heartbeat mirrors ws/gateway.ts's interval exactly, including the
// order: identity check → if missedPings >= 2 close 4002 → increment →
// send ping envelope → refresh presence.
func (s *Server) heartbeat(c *conn) {
	ticker := time.NewTicker(s.heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			current := s.agents[c.agentID] == c
			s.mu.Unlock()
			if !current {
				return
			}
			if c.missedPings.Load() >= 2 {
				s.logger.Printf("ws_heartbeat_timeout agentId=%s ownerId=%s missedPings=%d",
					c.agentID, c.ownerID, c.missedPings.Load())
				c.close(websocket.StatusCode(CloseHeartbeatTimeout), "heartbeat timeout")
				return
			}
			c.missedPings.Add(1)
			c.enqueue(verse.NewEnvelope(verse.EventPing, struct{}{}).Bytes())
			s.setPresence(context.Background(), c.agentID)
		}
	}
}

// onAgentFrame handles client→server frames. TS's onMessage knows exactly
// two types: pong (identity-guarded; resets the heartbeat counter and
// refreshes presence) and ack (NOT identity-guarded — the socket's own
// agentId closure is the only check, so an ack is processed even in the
// replace race window). Malformed frames are ignored.
func (s *Server) onAgentFrame(c *conn, data []byte) {
	var frame struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		return
	}
	switch frame.Type {
	case verse.EventPong:
		s.mu.Lock()
		current := s.agents[c.agentID] == c
		s.mu.Unlock()
		if current {
			c.missedPings.Store(0)
			s.setPresence(context.Background(), c.agentID)
		}
	case verse.EventAck:
		s.handleAck(c.agentID, frame.Payload)
	}
}

// resolveAckMessageCreatedAt resolves a message's real createdAt for
// an ack (ACK_CURSORS_V1 §3.2 step 1): the client's timestamp is never
// trusted, and the durable lookup is the last resort, not the first —
// the recent-message cache and the pending-ingest stream tail both
// carry the authoritative ts the send path assigned. found=false means
// unresolvable everywhere; the caller falls back to the early-ack
// stash, exactly as the old PG-only lookup did when it found no row.
func (s *Server) resolveAckMessageCreatedAt(ctx context.Context, conversationID, messageID string) (int64, bool) {
	if raw, err := s.rdb.LRange(ctx, verse.RecentCacheKey(conversationID), 0, -1).Result(); err == nil {
		for _, item := range raw {
			var e map[string]any
			if err := json.Unmarshal([]byte(item), &e); err != nil {
				continue // malformed entry — not a resolution source
			}
			id, _ := e["id"].(string)
			createdF, ok := e["createdAt"].(float64)
			if id == messageID && ok && !math.IsNaN(createdF) && !math.IsInf(createdF, 0) {
				return int64(createdF), true
			}
		}
	}
	if tail, err := s.rdb.XRevRangeN(ctx, verse.IngestStream, "+", "-", pendingIngestScanCount).Result(); err == nil {
		for _, xm := range tail {
			f := streamFields(xm)
			if f["id"] == messageID && f["conversationId"] == conversationID {
				if tsF, err := strconv.ParseFloat(f["ts"], 64); err == nil && !math.IsNaN(tsF) && !math.IsInf(tsF, 0) {
					return int64(tsF), true
				}
			}
		}
	}
	ms, found, err := findMessageCreatedMs(ctx, s.pool, messageID, conversationID)
	if err != nil {
		return 0, false
	}
	return ms, found
}

// handleAck ports ws/gateway.ts's handleAck. Mention acks are keyed on
// the mentions row id (the target may not be a conversation
// participant, so there is no cursor to advance); message acks advance
// the delivery cursor gated on the message's real createdAt — never a
// client timestamp, never backward. An ack for a row the ingest
// consumer hasn't persisted yet is stashed as a Redis early-ack
// (UUID-shaped ids only — the stash key is built from client input);
// deliverBacklog filters stashed ids out, bridging the persist window.
//
// Cursor acks v1 (WI-4): dual mode keeps the PG write AND advances the
// Redis hot cursor; redis mode advances the cursor only — PG moves at
// checkpoint; legacy is the old path untouched. Mention acks join the
// checkpoint set in dual/redis mode (in redis mode that set is the
// ONLY record until the checkpoint lands).
func (s *Server) handleAck(agentID string, payload json.RawMessage) {
	var p struct {
		ConversationID string `json:"conversationId"`
		MessageID      string `json:"messageId"`
		MentionID      string `json:"mentionId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}
	ctx := context.Background()
	if s.pool == nil {
		return
	}
	mode := ackCursorMode()
	if p.MentionID != "" {
		found, err := findMentionForAgent(ctx, s.pool, p.MentionID, agentID)
		if err != nil {
			return
		}
		if !found {
			// Not persisted yet — stash the ACK (guard the key shape:
			// mention ids are server-generated UUIDs).
			if uuidRe.MatchString(p.MentionID) {
				_ = s.rdb.Set(ctx, verse.EarlyAckMentionKey(p.MentionID), "1",
					verse.EarlyAckTTLSeconds*time.Second).Err()
				// The id also joins the checkpoint set, so the ack
				// lands on the row once the ingest consumer persists
				// it — the stash alone only filters one backlog.
				if mode != ackModeLegacy {
					s.addMentionAck(ctx, agentID, p.MentionID)
				}
			}
			return
		}
		if mode != ackModeRedis {
			if err := ackMention(ctx, s.pool, p.MentionID, agentID); err != nil {
				s.logger.Printf("mention_ack_error agentId=%s mentionId=%s err=%v", agentID, p.MentionID, err)
			}
		}
		if mode != ackModeLegacy {
			s.addMentionAck(ctx, agentID, p.MentionID)
		}
		return
	}
	if p.ConversationID == "" || p.MessageID == "" {
		return
	}
	createdMs, found := s.resolveAckMessageCreatedAt(ctx, p.ConversationID, p.MessageID)
	if !found {
		// Same early-ACK race as mentions above: stash it for the
		// backlog filter.
		if uuidRe.MatchString(p.MessageID) {
			_ = s.rdb.Set(ctx, verse.EarlyAckMsgKey(p.ConversationID, agentID, p.MessageID), "1",
				verse.EarlyAckTTLSeconds*time.Second).Err()
		}
		return
	}
	if mode != ackModeRedis {
		if err := advanceLastDeliveredMs(ctx, s.pool, p.ConversationID, agentID, createdMs); err != nil {
			s.logger.Printf("message_ack_error agentId=%s messageId=%s err=%v", agentID, p.MessageID, err)
			return
		}
	}
	if mode != ackModeLegacy {
		if advanced, err := s.advanceAckCursor(ctx, agentID, p.ConversationID, createdMs, p.MessageID); err != nil {
			s.logger.Printf("ack_cursor_error agentId=%s conversationId=%s err=%v", agentID, p.ConversationID, err)
		} else if advanced {
			s.logger.Printf("ack_redis_advances agentId=%s conversationId=%s count=1", agentID, p.ConversationID)
		}
	}
	s.logger.Printf("message_ack agentId=%s conversationId=%s messageId=%s ackLatencyMs=%d",
		agentID, p.ConversationID, p.MessageID, nowMs()-createdMs)
}

// AgentCount reports live agent sockets (bench/report introspection).
func (s *Server) AgentCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.agents)
}
