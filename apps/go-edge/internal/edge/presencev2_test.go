package edge

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"aiverse/go-edge/internal/verse"
)

// waitCollected polls until the agent's join sits in the pending
// digest. connectAgent returns when the client sees agent_connected,
// but the collect happens after the live transition on the server
// goroutine — a manual flush issued before the collect would snapshot
// the wrong window.
func waitCollected(t *testing.T, ts *testServer, agentID string) {
	t.Helper()
	waitFor(t, "digest collect for "+agentID, 3*time.Second, func() bool {
		ts.srv.digestMu.Lock()
		defer ts.srv.digestMu.Unlock()
		_, ok := ts.srv.digestJoined[agentID]
		return ok
	})
}

func waitCollectedLeft(t *testing.T, ts *testServer, agentID string) {
	t.Helper()
	waitFor(t, "digest left-collect for "+agentID, 3*time.Second, func() bool {
		ts.srv.digestMu.Lock()
		defer ts.srv.digestMu.Unlock()
		_, ok := ts.srv.digestLeft[agentID]
		return ok
	})
}

// Presence v2 (PHASE1_SPEC WI-3) — mirrors ws/presenceV2.test.ts:
// (a) digest entries reach room co-members only, (b) a room above
// 1,000 active collapses to a presence_summary while a small room in
// the same flush still enumerates, (c) THREAD_PARTICIPANT_JOINED is
// one room-scoped broadcast, delivered only to members, replayed from
// the backlog.

// frameLog accumulates a client's frames across polls — the mirror of
// presenceV2.test.ts's frames arrays + waitForFrameFrom.
type frameLog struct{ frames [][]byte }

func (l *frameLog) poll(c *testClient, window time.Duration) {
	l.frames = append(l.frames, c.collectFrames(window)...)
}

// waitFor polls until a frame at index >= from matches, returning it.
func (l *frameLog) waitFor(t *testing.T, c *testClient, what string, timeout time.Duration, from int, pred func(raw []byte) bool) []byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		for i := from; i < len(l.frames); i++ {
			if pred(l.frames[i]) {
				return l.frames[i]
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		l.poll(c, 200*time.Millisecond)
	}
}

func digestSummaries(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	p := framePayload(t, raw)
	out := []map[string]any{}
	if list, ok := p["summaries"].([]any); ok {
		for _, item := range list {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

func summaryFor(summaries []map[string]any, roomID string) map[string]any {
	for _, s := range summaries {
		if s["room_conversation_id"] == roomID {
			return s
		}
	}
	return nil
}

func TestPresenceV2DigestRoomScoped(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	a := seedAgent(t, ts.pool, &owner, "Pv2Subject", "offline", nil)
	b := seedAgent(t, ts.pool, &owner, "Pv2Outsider", "offline", nil)
	c := seedAgent(t, ts.pool, &owner, "Pv2Peer", "offline", nil)

	// A and C share a conversation; B is in none. Created before any
	// socket connects, so both room sets populate at the live
	// transition.
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, a, base, base)
	seedParticipant(t, ts.pool, convID, c, base, base)

	bConn := connectAgent(t, ts, b)
	cConn := connectAgent(t, ts, c)
	bLog, cLog := &frameLog{}, &frameLog{}
	// Let B's and C's own join entries flush in their own window — the
	// assertions below measure only A's transitions.
	time.Sleep(1400 * time.Millisecond)
	bLog.poll(bConn, 50*time.Millisecond)
	bMark := len(bLog.frames)

	aConn := connectAgent(t, ts, a)
	digest := cLog.waitFor(t, cConn, "C's digest with A's join", 8*time.Second, 0,
		func(raw []byte) bool {
			if frameType(t, raw) != verse.EventPresenceDigest {
				return false
			}
			joined, _ := digestLists(t, raw)
			for _, j := range joined {
				if j["agent_id"] == a {
					return true
				}
			}
			return false
		})
	joined, _ := digestLists(t, digest)
	var entry map[string]any
	for _, j := range joined {
		if j["agent_id"] == a {
			entry = j
		}
	}
	// Wire shape unchanged for sub-threshold traffic: the internal
	// room attribution never reaches the socket, and no summaries
	// appear.
	if len(entry) != 3 || entry["name"] != "Pv2Subject" {
		t.Fatalf("digest joined entry = %v, want exactly {agent_id, name, capabilities}", entry)
	}
	if caps, _ := entry["capabilities"].([]any); len(caps) != 0 {
		t.Fatalf("digest joined capabilities = %v, want []", entry["capabilities"])
	}
	if _, has := framePayload(t, digest)["summaries"]; has {
		t.Fatal("sub-threshold digest carried summaries")
	}

	// B shares no room with A (or C): a full window passes and no
	// digest is delivered to B at all — scoping drops every entry.
	bLog.poll(bConn, 1400*time.Millisecond)
	for _, raw := range bLog.frames[bMark:] {
		if frameType(t, raw) == verse.EventPresenceDigest {
			t.Fatalf("outsider received a presence_digest: %s", raw)
		}
	}

	// A leaves: C perceives the departure, B still perceives nothing.
	aConn.ws.CloseNow()
	cLog.waitFor(t, cConn, "C's digest with A's departure", 8*time.Second, 0,
		func(raw []byte) bool {
			if frameType(t, raw) != verse.EventPresenceDigest {
				return false
			}
			_, left := digestLists(t, raw)
			for _, l := range left {
				if l["agent_id"] == a {
					return true
				}
			}
			return false
		})
	bLog.poll(bConn, 1400*time.Millisecond)
	for _, raw := range bLog.frames[bMark:] {
		if frameType(t, raw) == verse.EventPresenceDigest {
			t.Fatalf("outsider received a presence_digest after A left: %s", raw)
		}
	}
	bConn.ws.CloseNow()
	cConn.ws.CloseNow()
}

func TestPresenceV2OversizeSummary(t *testing.T) {
	// Window pinned open + manual flushes: the measured actions land
	// in exactly one window deterministically (the TS suite relies on
	// its 1s window + concurrent connects for the same grouping).
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = time.Hour })
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	m := seedAgent(t, ts.pool, &owner, "Pv2Member", "offline", nil)
	s1 := seedAgent(t, ts.pool, &owner, "Pv2Joiner", "offline", nil)
	s2 := seedAgent(t, ts.pool, &owner, "Pv2Leaver", "offline", nil)
	s3 := seedAgent(t, ts.pool, &owner, "Pv2SmallPeer", "offline", nil)

	// Seed the oversize room directly: 1,003 participant rows (M, S1,
	// S2 + 1,000 fillers) — the spec's sanctioned light seam, same as
	// the TS suite. "Connected" state for fillers is the production
	// presence truth: Redis TTL keys. The summary computation and the
	// entry suppression under test are the production flush/delivery
	// code paths, exercised end to end over real sockets.
	bigRoom := seedConversation(t, ts.pool)
	smallRoom := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)

	var fillerIDs []string
	rows, err := ts.pool.Query(ctx,
		`INSERT INTO agents (owner_id, name, agent_card, status, api_key_hash)
		 SELECT NULL, 'Pv2Filler-' || g, '{}'::jsonb, 'offline', 'x'
		 FROM generate_series(1, 1000) AS g RETURNING id`)
	if err != nil {
		t.Fatalf("bulk-seed fillers: %v", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		fillerIDs = append(fillerIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(fillerIDs) != 1000 {
		t.Fatalf("fillers = %d (err=%v), want 1000", len(fillerIDs), err)
	}
	bigMembers := append([]string{m, s1, s2}, fillerIDs...)
	if _, err := ts.pool.Exec(ctx,
		`INSERT INTO conversation_participants (conversation_id, agent_id, joined_at, last_delivered_at)
		 SELECT $1, u::uuid, $3, $3 FROM unnest($2::text[]) AS u`,
		bigRoom, bigMembers, base); err != nil {
		t.Fatalf("seed big-room participants: %v", err)
	}
	seedParticipant(t, ts.pool, smallRoom, m, base, base)
	seedParticipant(t, ts.pool, smallRoom, s3, base, base)

	// Fillers are "connected" via the production presence keys.
	pipe := ts.rdb.Pipeline()
	for _, id := range fillerIDs {
		pipe.Set(ctx, verse.PresenceKey(id), "1", 300*time.Second)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		t.Fatalf("seed filler presence: %v", err)
	}
	defer func() {
		pipe := ts.rdb.Pipeline()
		for _, id := range fillerIDs {
			pipe.Del(ctx, verse.PresenceKey(id))
		}
		_, _ = pipe.Exec(ctx)
	}()

	// S2 connects first; flush its join out by hand (it is delivered
	// to nobody — no other member is live yet).
	s2Conn := connectAgent(t, ts, s2)
	waitCollected(t, ts, s2)
	ts.srv.flushPresenceDigest()
	s2Conn.collectFrames(300 * time.Millisecond)

	// M connects: its own join collects with rooms {big, small}. The
	// flush delivers M a digest carrying ONLY the big room's summary
	// (M's own entry is self-stripped; the entry is attributable to
	// the oversize room, so it collapses into counts). Active at this
	// flush: 1,000 fillers + S2 + M = 1,002.
	mConn := connectAgent(t, ts, m)
	mLog := &frameLog{}
	waitCollected(t, ts, m)
	ts.srv.flushPresenceDigest()
	marker := mLog.waitFor(t, mConn, "M's marker summary digest", 8*time.Second, 0,
		func(raw []byte) bool {
			return frameType(t, raw) == verse.EventPresenceDigest &&
				summaryFor(digestSummaries(t, raw), bigRoom) != nil
		})
	summary := summaryFor(digestSummaries(t, marker), bigRoom)
	if summary["joined_count"] != float64(1) || summary["left_count"] != float64(0) ||
		summary["active_count"] != float64(1002) {
		t.Fatalf("marker summary = %v, want joined 1 / left 0 / active 1002", summary)
	}
	if joined, left := digestLists(t, marker); len(joined) != 0 || len(left) != 0 {
		t.Fatalf("marker digest enumerated entries: joined %v left %v", joined, left)
	}
	mMark := len(mLog.frames)

	// Measured window: S1 joins (big room only), S3 joins (small room
	// only), S2 leaves (big room only). Each collect is confirmed in
	// the pending digest before the flush, so the window's contents
	// are exact.
	s1Conn := connectAgent(t, ts, s1)
	waitCollected(t, ts, s1)
	s3Conn := connectAgent(t, ts, s3)
	waitCollected(t, ts, s3)
	s2Conn.ws.CloseNow()
	waitCollectedLeft(t, ts, s2)
	ts.srv.flushPresenceDigest()

	flush := mLog.waitFor(t, mConn, "M's measured-window digest", 8*time.Second, mMark,
		func(raw []byte) bool {
			if frameType(t, raw) != verse.EventPresenceDigest {
				return false
			}
			joined, _ := digestLists(t, raw)
			for _, j := range joined {
				if j["agent_id"] == s3 {
					return summaryFor(digestSummaries(t, raw), bigRoom) != nil
				}
			}
			return false
		})
	// The oversize room reports counts only: S1's join and S2's leave
	// are inside joined_count/left_count, never enumerated. (S2's
	// presence key was cleared by its close, so active is 1,002
	// again: 1,000 fillers + M + S1.)
	summary = summaryFor(digestSummaries(t, flush), bigRoom)
	if summary["joined_count"] != float64(1) || summary["left_count"] != float64(1) ||
		summary["active_count"] != float64(1002) {
		t.Fatalf("measured summary = %v, want joined 1 / left 1 / active 1002", summary)
	}
	// The small room in the same flush still enumerates, wire shape
	// unchanged (no room attribution leaks).
	joined, left := digestLists(t, flush)
	if len(joined) != 1 || joined[0]["agent_id"] != s3 || len(joined[0]) != 3 {
		t.Fatalf("measured joined = %v, want exactly S3's clean entry", joined)
	}
	if len(left) != 0 {
		t.Fatalf("measured left = %v, want [] (S2 collapsed into the summary)", left)
	}
	// And across every digest M received in the measured window, the
	// oversize room's subjects were never enumerated.
	for _, raw := range mLog.frames[mMark:] {
		if frameType(t, raw) != verse.EventPresenceDigest {
			continue
		}
		j, l := digestLists(t, raw)
		for _, e := range append(j, l...) {
			if e["agent_id"] == s1 || e["agent_id"] == s2 {
				t.Fatalf("oversize subject enumerated in digest: %s", raw)
			}
		}
	}
	s1Conn.ws.CloseNow()
	s3Conn.ws.CloseNow()
	mConn.ws.CloseNow()
}

func TestPresenceV2RoomScopedJoinBroadcast(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	memberLive := seedAgent(t, ts.pool, &owner, "Pv2RoomLive", "offline", nil)
	memberOffline := seedAgent(t, ts.pool, &owner, "Pv2RoomOffline", "offline", nil)
	outsider := seedAgent(t, ts.pool, &owner, "Pv2RoomOutsider", "offline", nil)
	joiner := seedAgent(t, ts.pool, &owner, "Pv2RoomJoiner", "offline", nil)

	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, memberLive, base, base)
	seedParticipant(t, ts.pool, convID, memberOffline, base, base)

	liveConn := connectAgent(t, ts, memberLive)
	outConn := connectAgent(t, ts, outsider)
	// The joiner connects BEFORE its participant row exists (the
	// invite route runs on "another process"): its room set is empty
	// until the broadcast below heals it.
	joinerConn := connectAgent(t, ts, joiner)
	liveConn.collectFrames(400 * time.Millisecond)
	outConn.collectFrames(400 * time.Millisecond)
	joinerConn.collectFrames(400 * time.Millisecond)

	// Count fanout publishes on the real channel: the join must cost
	// exactly ONE publish (the old per-participant loop cost one per
	// existing participant).
	sub := ts.rdb.Subscribe(ctx, verse.FanoutChannel)
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatalf("subscribe fanout: %v", err)
	}
	defer sub.Close()
	fanoutCh := sub.Channel()

	// The route's half: the participant row lands first, then the
	// single room-scoped broadcast (join semantics: except = joiner).
	seedParticipant(t, ts.pool, convID, joiner, time.Now(), base)
	joinedFrame := envelopeBytes(t, verse.EventThreadParticipantJoin, map[string]any{
		"conversation_id": convID,
		"agent_id":        joiner,
		"invited_by":      nil,
	})
	ts.srv.BroadcastParticipantJoined(ctx, convID, joinedFrame, joiner)

	// Delivered live to a connected member…
	delivered := liveConn.nextFrameOfType(t, verse.EventThreadParticipantJoin, 3*time.Second)
	p := framePayload(t, delivered)
	if p["conversation_id"] != convID || p["agent_id"] != joiner {
		t.Fatalf("member's join frame = %v", p)
	}
	// …never to a connected non-member (room-scope filter)…
	for _, raw := range outConn.collectFrames(800 * time.Millisecond) {
		if frameType(t, raw) == verse.EventThreadParticipantJoin {
			t.Fatalf("outsider received a room-scoped join frame: %s", raw)
		}
	}
	// …and not to the joiner (the except is preserved).
	for _, raw := range joinerConn.collectFrames(300 * time.Millisecond) {
		if frameType(t, raw) == verse.EventThreadParticipantJoin {
			t.Fatalf("joiner was notified of its own join: %s", raw)
		}
	}

	// Exactly one publish carried the join, in room-scoped broadcast
	// shape.
	time.Sleep(300 * time.Millisecond)
	var joinedPublishes []map[string]any
	drain := time.NewTimer(100 * time.Millisecond)
loop:
	for {
		select {
		case msg := <-fanoutCh:
			var fanout map[string]any
			if err := json.Unmarshal([]byte(msg.Payload), &fanout); err != nil {
				continue
			}
			event, _ := fanout["event"].(map[string]any)
			payload, _ := event["payload"].(map[string]any)
			if event["type"] == verse.EventThreadParticipantJoin && payload["agent_id"] == joiner {
				joinedPublishes = append(joinedPublishes, fanout)
			}
		case <-drain.C:
			break loop
		}
	}
	if len(joinedPublishes) != 1 {
		t.Fatalf("join fanout publishes = %d, want exactly 1", len(joinedPublishes))
	}
	pub := joinedPublishes[0]
	if pub["kind"] != "broadcast" || pub["roomConversationId"] != convID || pub["exceptAgentId"] != joiner {
		t.Fatalf("join publish shape = %v", pub)
	}

	// The heal: the first broadcast added the room to the joiner's
	// local set before the scope filter ran, so a second room-scoped
	// broadcast (invite semantics — no exception) now reaches the
	// joiner too, while the outsider stays filtered.
	inviteFrame := envelopeBytes(t, verse.EventThreadParticipantJoin, map[string]any{
		"conversation_id": convID,
		"agent_id":        memberOffline,
		"invited_by":      nil,
	})
	ts.srv.BroadcastParticipantJoined(ctx, convID, inviteFrame, "")
	healed := joinerConn.nextFrameOfType(t, verse.EventThreadParticipantJoin, 3*time.Second)
	if p := framePayload(t, healed); p["agent_id"] != memberOffline {
		t.Fatalf("joiner's healed frame = %v", p)
	}
	for _, raw := range outConn.collectFrames(500 * time.Millisecond) {
		if frameType(t, raw) == verse.EventThreadParticipantJoin {
			t.Fatalf("outsider received the invite broadcast: %s", raw)
		}
	}

	// The offline member still learns of the join — from the backlog
	// on connect, the correctness path the filtered live frame is
	// allowed to rely on.
	offlineConn := connectAgent(t, ts, memberOffline)
	replayed := offlineConn.nextFrameOfType(t, verse.EventThreadParticipantJoin, 3*time.Second)
	if p := framePayload(t, replayed); p["agent_id"] != joiner || p["conversation_id"] != convID {
		t.Fatalf("backlog join replay = %v", p)
	}
	offlineConn.ws.CloseNow()
	liveConn.ws.CloseNow()
	outConn.ws.CloseNow()
	joinerConn.ws.CloseNow()
}

func TestPresenceV2ConnectionRoomHelpers(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	watcher := seedAgent(t, ts.pool, &owner, "Pv2HelperWatcher", "offline", nil)
	subject := seedAgent(t, ts.pool, &owner, "Pv2HelperSubject", "offline", nil)
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, watcher, base, base)

	w := connectAgent(t, ts, watcher)
	w.collectFrames(400 * time.Millisecond)
	frame := envelopeBytes(t, verse.EventThreadParticipantJoin, map[string]any{
		"conversation_id": convID,
		"agent_id":        subject,
		"invited_by":      nil,
	})

	// Member: the room-scoped broadcast arrives.
	ts.srv.BroadcastParticipantJoined(ctx, convID, frame, "")
	w.nextFrameOfType(t, verse.EventThreadParticipantJoin, 3*time.Second)

	// After removeConnectionRoom (the leave route's helper) the same
	// broadcast is filtered for this socket…
	ts.srv.removeConnectionRoom(watcher, convID)
	ts.srv.BroadcastParticipantJoined(ctx, convID, frame, "")
	for _, raw := range w.collectFrames(700 * time.Millisecond) {
		if frameType(t, raw) == verse.EventThreadParticipantJoin {
			t.Fatalf("frame delivered after removeConnectionRoom: %s", raw)
		}
	}
	// …and addConnectionRoom restores delivery.
	ts.srv.addConnectionRoom(watcher, convID)
	ts.srv.BroadcastParticipantJoined(ctx, convID, frame, "")
	w.nextFrameOfType(t, verse.EventThreadParticipantJoin, 3*time.Second)
	w.ws.CloseNow()
}
