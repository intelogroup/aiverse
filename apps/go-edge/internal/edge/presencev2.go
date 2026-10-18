package edge

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"aiverse/go-edge/internal/verse"
)

// ── Presence v2 (PHASE1_SPEC WI-3) ────────────────────────────────────
//
// Port of the WI-3 sections of ws/gateway.ts: per-connection room sets,
// room-scoped presence digests with oversize summaries, and the
// THREAD_PARTICIPANT_JOINED fanout diet. Presence truth stays in the
// Redis presence:* keys + Postgres participant rows; the room set is a
// process-local delivery-routing cache rebuilt from the rows on every
// connect, exactly as in TS.

// digestJoinedEntry / digestLeftEntry are the FANOUT-INTERNAL digest
// entry shapes: each carries the subject's room-set snapshot at
// collect time in `rooms` — always present on this edge's own
// flushes. The attribution rides the internal fanout envelope only:
// scopePresenceDigest strips it before any socket write, so the
// client wire shape for sub-threshold traffic is unchanged
// ({agent_id, name, capabilities} / {agent_id}).
type digestJoinedEntry struct {
	AgentID      string   `json:"agent_id"`
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
	Rooms        []string `json:"rooms"`
}

type digestLeftEntry struct {
	AgentID string   `json:"agent_id"`
	Rooms   []string `json:"rooms"`
}

// presenceSummary is the wire-additive digest payload member present
// only when a flush contains entries attributable to an oversize room:
// the room's attributable entries collapse into these counts, delivered
// to that room's members in place of the entries.
type presenceSummary struct {
	RoomConversationID string `json:"room_conversation_id"`
	JoinedCount        int    `json:"joined_count"`
	LeftCount          int    `json:"left_count"`
	ActiveCount        int    `json:"active_count"`
}

// sortedRoomList flattens a room set for a digest snapshot. TS spreads
// its Set in insertion order; the snapshot is fanout-internal and
// stripped before the wire, so the order is unobservable — sorted
// keeps this edge's fanout bytes deterministic.
func sortedRoomList(rooms map[string]struct{}) []string {
	out := make([]string, 0, len(rooms))
	for id := range rooms {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// connRoomsSnapshot returns the conn's current room set as a digest
// attribution snapshot.
func (s *Server) connRoomsSnapshot(c *conn) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return sortedRoomList(c.rooms)
}

// addRoomLocked records a room on a conn. Caller holds s.mu.
func addRoomLocked(c *conn, conversationID string) {
	if c.rooms == nil {
		c.rooms = make(map[string]struct{})
	}
	c.rooms[conversationID] = struct{}{}
}

// addConnectionRoom / removeConnectionRoom are the exported-helper
// ports (ws/gateway.ts): writers of a connection's room set besides
// the live-transition population and the fanout subscriber's own
// maintenance. In TS the join/invite/leave HTTP routes call them; the
// Go edge serves no HTTP routes, so removeConnectionRoom has no caller
// here yet — in both implementations the set is best-effort and
// rebuilt from Postgres on every connect, so a cross-process
// membership change this process never observes goes stale in exactly
// the same way.
func (s *Server) addConnectionRoom(agentID, conversationID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.agents[agentID]; c != nil {
		addRoomLocked(c, conversationID)
	}
}

func (s *Server) removeConnectionRoom(agentID, conversationID string) {
	s.mu.Lock()
	if c := s.agents[agentID]; c != nil {
		delete(c.rooms, conversationID)
	}
	s.mu.Unlock()
	// The leave route is this helper's only TS caller: the room's
	// participant rows just changed, so a cached oversize
	// determination for it is stale.
	s.invalidateOversizeDetermination(conversationID)
}

// BroadcastParticipantJoined publishes THREAD_PARTICIPANT_JOINED as
// ONE room-scoped broadcast (WI-3 change 4) instead of the old
// per-participant publish loop — delivery restricts it to sockets
// whose room set contains the conversation. exceptAgentID preserves
// the room-join semantics (the joiner is not notified of their own
// join); invites pass "" — the invitee IS notified, exactly as the old
// loop + explicit target send delivered it.
func (s *Server) BroadcastParticipantJoined(ctx context.Context, conversationID string, event []byte, exceptAgentID string) {
	s.PublishFanout(ctx, verse.FanoutMessage{
		Kind:               "broadcast",
		Event:              event,
		ExceptAgentID:      exceptAgentID,
		RoomConversationID: conversationID,
	})
}

// ── Oversize determinations (WI-3 change 3, cost-bounded) ────────────
//
// A room is oversize when its active membership — participant rows
// whose agent currently holds a live presence key — exceeds
// presenceOversizeRoomActiveThreshold. The determination itself is
// exact (Postgres rows ∩ the Redis presence set), but it is NOT
// recomputed on every flush: determinations are cached per room, so a
// flush whose rooms' membership has not changed issues no PG or Redis
// queries at all. A cached determination is dropped as soon as this
// process observes an event that can change it:
//   - a digest entry attributable to the room is collected (a member's
//     presence joined/left — the only way active membership moves), or
//   - a THREAD_PARTICIPANT_JOINED broadcast for the room is seen, or
//     the local leave path runs (participant rows changed), or
//   - the TTL expires — a backstop for changes no local event reveals
//     (e.g. a leave served by another gateway process).
//
// Participant counts change slowly, so the bounded staleness that
// remains is the accepted price of keeping the 1s flush off the
// database — the TS cache notes say the same.
const (
	presenceOversizeRoomActiveThreshold = 1000
	presenceOversizeCacheTTLMs          = 60_000
	presenceOversizeCacheMaxEntries     = 4096
)

type oversizeDetermination struct {
	oversize bool
	// Exact on the oversize path (participant rows ∩ live presence
	// keys). On the gated sub-threshold path it holds the participant
	// count — an upper bound on active membership, never read:
	// summaries are built only from oversize determinations.
	activeCount  int
	computedAtMs int64
}

func (s *Server) invalidateOversizeDetermination(conversationID string) {
	s.oversizeMu.Lock()
	delete(s.oversizeCache, conversationID)
	s.oversizeMu.Unlock()
}

// getOnlineAgentIDs ports presence.ts's getOnlineAgentIds: every agent
// with a live presence key, via SCAN (never KEYS). Falls back to the
// Postgres status column when Redis is unreachable, so readers degrade
// to the old behavior instead of erroring; an error surfaces only when
// both stores fail.
func (s *Server) getOnlineAgentIDs(ctx context.Context) (map[string]struct{}, error) {
	ids := make(map[string]struct{})
	var cursor uint64
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, "presence:*", 1000).Result()
		if err != nil {
			s.logger.Printf("presence_redis_fallback op=scan err=%v", err)
			if s.pool == nil {
				return nil, err
			}
			rows, qerr := s.pool.Query(ctx, `SELECT id FROM agents WHERE status = 'online'`)
			if qerr != nil {
				return nil, qerr
			}
			defer rows.Close()
			out := make(map[string]struct{})
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					return nil, err
				}
				out[id] = struct{}{}
			}
			return out, rows.Err()
		}
		for _, k := range keys {
			ids[strings.TrimPrefix(k, "presence:")] = struct{}{}
		}
		cursor = next
		if cursor == 0 {
			return ids, nil
		}
	}
}

func (s *Server) computeOversizeDetermination(ctx context.Context, roomID string, sharedOnlineIds func() (map[string]struct{}, error)) (oversizeDetermination, error) {
	// Active membership can never exceed the participant count, so
	// only a room with more participants than the threshold can be
	// oversize: a cheap COUNT gates the Redis presence scan, which the
	// caller shares across every room one flush actually computes.
	var participantCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM conversation_participants WHERE conversation_id = $1`,
		roomID).Scan(&participantCount); err != nil {
		return oversizeDetermination{}, err
	}
	if participantCount <= presenceOversizeRoomActiveThreshold {
		return oversizeDetermination{oversize: false, activeCount: participantCount, computedAtMs: nowMs()}, nil
	}
	onlineIds, err := sharedOnlineIds()
	if err != nil {
		return oversizeDetermination{}, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT agent_id FROM conversation_participants WHERE conversation_id = $1`, roomID)
	if err != nil {
		return oversizeDetermination{}, err
	}
	defer rows.Close()
	activeCount := 0
	for rows.Next() {
		var agentID string
		if err := rows.Scan(&agentID); err != nil {
			return oversizeDetermination{}, err
		}
		if _, ok := onlineIds[agentID]; ok {
			activeCount++
		}
	}
	if err := rows.Err(); err != nil {
		return oversizeDetermination{}, err
	}
	return oversizeDetermination{
		oversize:     activeCount > presenceOversizeRoomActiveThreshold,
		activeCount:  activeCount,
		computedAtMs: nowMs(),
	}, nil
}

func (s *Server) determineOversize(ctx context.Context, roomID string, sharedOnlineIds func() (map[string]struct{}, error)) (oversizeDetermination, error) {
	s.oversizeMu.Lock()
	cached, ok := s.oversizeCache[roomID]
	s.oversizeMu.Unlock()
	if ok && nowMs()-cached.computedAtMs < presenceOversizeCacheTTLMs {
		return cached, nil
	}
	determination, err := s.computeOversizeDetermination(ctx, roomID, sharedOnlineIds)
	if err != nil {
		return oversizeDetermination{}, err
	}
	s.oversizeMu.Lock()
	s.oversizeCache[roomID] = determination
	if len(s.oversizeCache) > presenceOversizeCacheMaxEntries {
		// Opportunistic bound: expired entries go first; if the map
		// is still over the cap, clear it — a lost entry costs one
		// lazy recomputation, never correctness.
		now := nowMs()
		for id, entry := range s.oversizeCache {
			if now-entry.computedAtMs >= presenceOversizeCacheTTLMs {
				delete(s.oversizeCache, id)
			}
		}
		if len(s.oversizeCache) > presenceOversizeCacheMaxEntries {
			s.oversizeCache = make(map[string]oversizeDetermination)
		}
	}
	s.oversizeMu.Unlock()
	return determination, nil
}

// resolveOversizeSummaries is flushPresenceDigest's WI-3 resolution:
// for every room attributed by the window's entries, determine
// oversize (from the per-room cache — computed on a miss) and build
// the per-room summary. Any failure degrades the whole flush to fully
// enumerated (the pre-WI-3 behavior) and logs, exactly as the TS
// flush's try/catch does — the digest is advisory and must not be lost
// to an oversize computation error.
func (s *Server) resolveOversizeSummaries(joined []digestJoinedEntry, left []digestLeftEntry) (summaries []presenceSummary, oversizeRooms []string) {
	attributed := make([]string, 0)
	seen := make(map[string]bool)
	collect := func(rooms []string) {
		for _, roomID := range rooms {
			if !seen[roomID] {
				seen[roomID] = true
				attributed = append(attributed, roomID)
			}
		}
	}
	for _, e := range joined {
		collect(e.Rooms)
	}
	for _, e := range left {
		collect(e.Rooms)
	}
	if len(attributed) == 0 || s.pool == nil {
		return nil, nil
	}
	ctx := context.Background()
	var online map[string]struct{}
	var onlineErr error
	onlineLoaded := false
	sharedOnlineIds := func() (map[string]struct{}, error) {
		if !onlineLoaded {
			online, onlineErr = s.getOnlineAgentIDs(ctx)
			onlineLoaded = true
		}
		return online, onlineErr
	}
	for _, roomID := range attributed {
		determination, err := s.determineOversize(ctx, roomID, sharedOnlineIds)
		if err != nil {
			s.logger.Printf("presence_digest_oversize_check_failed err=%v", err)
			return nil, nil
		}
		if !determination.oversize {
			continue
		}
		oversizeRooms = append(oversizeRooms, roomID)
		summary := presenceSummary{RoomConversationID: roomID, ActiveCount: determination.activeCount}
		for _, e := range joined {
			for _, r := range e.Rooms {
				if r == roomID {
					summary.JoinedCount++
					break
				}
			}
		}
		for _, e := range left {
			for _, r := range e.Rooms {
				if r == roomID {
					summary.LeftCount++
					break
				}
			}
		}
		summaries = append(summaries, summary)
	}
	return summaries, oversizeRooms
}

// ── Digest delivery scoping ───────────────────────────────────────────

// scopePresenceDigest scopes one digest envelope for one receiving
// socket (WI-3): an entry survives iff the subject shares ≥1 room with
// the receiver and at least one shared room is sub-threshold (oversize
// rooms are covered by their presence_summary instead of entries); the
// receiver's own entry is stripped, as the original digest always did;
// a summary survives iff the receiver is in the summarized room. The
// internal `rooms` attribution and `oversize_rooms` list never reach
// the wire. ok=false when nothing remains for this socket — the write
// is skipped. When nothing was filtered or stripped, the original
// serialized payload passes through untouched.
func scopePresenceDigest(raw []byte, selfID string, selfRooms map[string]struct{}) ([]byte, bool) {
	type joinedIn struct {
		AgentID      string    `json:"agent_id"`
		Name         string    `json:"name"`
		Capabilities []string  `json:"capabilities"`
		Rooms        *[]string `json:"rooms"`
	}
	type leftIn struct {
		AgentID string    `json:"agent_id"`
		Rooms   *[]string `json:"rooms"`
	}
	var env struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Ts      int64  `json:"ts"`
		Payload struct {
			Joined        []joinedIn        `json:"joined"`
			Left          []leftIn          `json:"left"`
			Summaries     []presenceSummary `json:"summaries"`
			OversizeRooms []string          `json:"oversize_rooms"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		// Unreadable digest shape — deliver as-is rather than drop it.
		return raw, true
	}
	oversize := make(map[string]bool, len(env.Payload.OversizeRooms))
	for _, roomID := range env.Payload.OversizeRooms {
		oversize[roomID] = true
	}
	inScope := func(agentID string, rooms *[]string) bool {
		if agentID == selfID {
			return false
		}
		// No attribution — a digest shape this build never emits (e.g.
		// a mixed-version fleet mate): deliver as before rather than
		// drop.
		if rooms == nil {
			return true
		}
		for _, roomID := range *rooms {
			if _, member := selfRooms[roomID]; member && !oversize[roomID] {
				return true
			}
		}
		return false
	}
	joined := make([]agentJoinedPayload, 0, len(env.Payload.Joined))
	for _, e := range env.Payload.Joined {
		if inScope(e.AgentID, e.Rooms) {
			caps := e.Capabilities
			if caps == nil {
				caps = []string{}
			}
			joined = append(joined, agentJoinedPayload{AgentID: e.AgentID, Name: e.Name, Capabilities: caps})
		}
	}
	left := make([]agentLeftPayload, 0, len(env.Payload.Left))
	for _, e := range env.Payload.Left {
		if inScope(e.AgentID, e.Rooms) {
			left = append(left, agentLeftPayload{AgentID: e.AgentID})
		}
	}
	summaries := make([]presenceSummary, 0, len(env.Payload.Summaries))
	for _, summary := range env.Payload.Summaries {
		if _, member := selfRooms[summary.RoomConversationID]; member {
			summaries = append(summaries, summary)
		}
	}
	if len(joined) == 0 && len(left) == 0 && len(summaries) == 0 {
		return nil, false
	}
	untouched := len(joined) == len(env.Payload.Joined) &&
		len(left) == len(env.Payload.Left) &&
		len(summaries) == len(env.Payload.Summaries) &&
		len(oversize) == 0
	if untouched {
		for _, e := range env.Payload.Joined {
			if e.Rooms != nil {
				untouched = false
				break
			}
		}
	}
	if untouched {
		for _, e := range env.Payload.Left {
			if e.Rooms != nil {
				untouched = false
				break
			}
		}
	}
	if untouched {
		return raw, true
	}
	out, err := json.Marshal(struct {
		Type    string                    `json:"type"`
		ID      string                    `json:"id"`
		Ts      int64                     `json:"ts"`
		Payload presenceDigestWirePayload `json:"payload"`
	}{env.Type, env.ID, env.Ts, presenceDigestWirePayload{Joined: joined, Left: left, Summaries: summaries}})
	if err != nil {
		return raw, true
	}
	return out, true
}

// presenceDigestWirePayload is the socket-facing digest payload: the
// internal rooms attribution and oversize_rooms list are stripped, and
// summaries appear only when at least one survives scoping.
type presenceDigestWirePayload struct {
	Joined    []agentJoinedPayload `json:"joined"`
	Left      []agentLeftPayload   `json:"left"`
	Summaries []presenceSummary    `json:"summaries,omitempty"`
}
