package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"aiverse/go-edge/internal/verse"
)

// Parity tests mirroring apps/gateway/src/ws/gateway.test.ts and
// ws/offlineDelivery.test.ts, per PARITY_SPEC §10. Same local stack as
// edge_test.go (Postgres aiverse_test + Redis); everything is seeded
// directly — unique owners/agents/conversations per test, like the TS
// suites' fresh registrations.

// ── seeding helpers ─────────────────────────────────────────────────────

func seedConversation(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO conversations (kind, is_public) VALUES ('room', true) RETURNING id`,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	return id
}

func seedParticipant(t *testing.T, pool *pgxpool.Pool, convID, agentID string, joinedAt, lastDelivered time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO conversation_participants (conversation_id, agent_id, joined_at, last_delivered_at)
		 VALUES ($1, $2, $3, $4)`,
		convID, agentID, joinedAt, lastDelivered)
	if err != nil {
		t.Fatalf("seed participant: %v", err)
	}
}

func seedMessage(t *testing.T, pool *pgxpool.Pool, convID, senderID, content string, createdAt time.Time) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO messages (conversation_id, sender_agent_id, content, created_at)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		convID, senderID, content, createdAt,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed message: %v", err)
	}
	return id
}

func seedMessageWithID(t *testing.T, pool *pgxpool.Pool, id, convID, senderID, content string, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO messages (id, conversation_id, sender_agent_id, content, created_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		id, convID, senderID, content, createdAt)
	if err != nil {
		t.Fatalf("seed message with id: %v", err)
	}
}

func seedMention(t *testing.T, pool *pgxpool.Pool, targetID, byID, byName, convID, messageID, content string, createdAt time.Time) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO mentions (target_agent_id, by_agent_id, by_name, conversation_id, message_id, is_public, content, created_at)
		 VALUES ($1, $2, $3, $4, $5, true, $6, $7) RETURNING id`,
		targetID, byID, byName, convID, messageID, content, createdAt,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed mention: %v", err)
	}
	return id
}

func seedTask(t *testing.T, pool *pgxpool.Pool, targetID, callerID string, request map[string]any) string {
	t.Helper()
	raw, _ := json.Marshal(request)
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO a2a_tasks (target_agent_id, caller_agent_id, state, request_message)
		 VALUES ($1, $2, 'submitted', $3::jsonb) RETURNING id`,
		targetID, callerID, string(raw),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed task: %v", err)
	}
	return id
}

type visitSeed struct {
	endsAt      time.Time
	maxActions  int
	actionsUsed int
	endedAt     *time.Time
	endedReason string
}

func seedVisit(t *testing.T, pool *pgxpool.Pool, agentID, ownerID string, v visitSeed) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO agent_visits (agent_id, owner_id, ends_at, max_actions, actions_used, ended_at, ended_reason)
		 VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')) RETURNING id`,
		agentID, ownerID, v.endsAt, v.maxActions, v.actionsUsed, v.endedAt, v.endedReason,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed visit: %v", err)
	}
	return id
}

func cacheEntryJSON(id, convID, senderID, content string, createdMs int64) string {
	raw, _ := json.Marshal(map[string]any{
		"id":             id,
		"conversationId": convID,
		"senderAgentId":  senderID,
		"content":        content,
		"replyToId":      nil,
		"createdAt":      createdMs,
	})
	return string(raw)
}

// xaddIngest writes one entry to the ingest stream in publishIngest's
// exact field shape (jobs/ingestConsumer.ts).
func xaddIngest(t *testing.T, ts *testServer, fields map[string]any) {
	t.Helper()
	args := []any{}
	for k, v := range fields {
		args = append(args, k, v)
	}
	if err := ts.rdb.Do(context.Background(), append([]any{"XADD", verse.IngestStream, "*"}, args...)...).Err(); err != nil {
		t.Fatalf("xadd ingest: %v", err)
	}
}

func messageFrames(frames [][]byte) []map[string]any {
	var out []map[string]any
	for _, raw := range frames {
		var f struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err == nil && f.Type == verse.EventMessage {
			out = append(out, f.Payload)
		}
	}
	return out
}

// ── connect gates ───────────────────────────────────────────────────────

func TestParityPaused4003(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "PausedAgent", "paused", nil)
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseAgentPaused {
		t.Fatalf("paused close code = %d, want 4003", code)
	}
}

func TestParityUnclaimed4005(t *testing.T) {
	ts := startTestServer(t)
	agentID := seedAgent(t, ts.pool, nil, "UnclaimedAgent", "offline", nil)
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseAgentUnclaimed {
		t.Fatalf("unclaimed close code = %d, want 4005", code)
	}
}

func TestParityVisitEndedSticky4008(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "StickyVisitAgent", "offline", nil)
	endedAt := time.Now().Add(-time.Hour)
	seedVisit(t, ts.pool, agentID, owner, visitSeed{
		endsAt:      time.Now().Add(time.Hour),
		maxActions:  100,
		endedAt:     &endedAt,
		endedReason: "owner_stopped",
	})
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseVisitEnded {
		t.Fatalf("sticky-ended visit close code = %d, want 4008", code)
	}
	// A sticky refusal must NOT re-announce: no new console_events row.
	var n int
	err := ts.pool.QueryRow(ctx,
		`SELECT count(*) FROM console_events WHERE agent_id = $1`, agentID).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("console_events rows = %d, want 0 (already-ended visits don't re-announce)", n)
	}
}

func TestParityVisitExpiringAnnounces4008(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "ExpiringVisitAgent", "offline", nil)
	visitID := seedVisit(t, ts.pool, agentID, owner, visitSeed{
		endsAt:     time.Now().Add(time.Hour),
		maxActions: 100,
	})

	// Owner console watches for the visit_ended push.
	console_ := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, seedOwnerTicket(t, ts.rdb, owner)))

	// The agent connects fine while the visit is active…
	live := connectAgent(t, ts, agentID)

	// …then the visit's deadline passes (as the sweep would find it).
	if _, err := ts.pool.Exec(ctx, `UPDATE agent_visits SET ends_at = $1 WHERE id = $2`,
		time.Now().Add(-time.Minute), visitID); err != nil {
		t.Fatal(err)
	}

	// A fresh connect attempt ends the visit and announces: this socket
	// closes 4008, the live socket is force-disconnected 4008, a
	// consoleEvents attention row lands, the console gets visit_ended.
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseVisitEnded {
		t.Fatalf("expiring-visit connect close code = %d, want 4008", code)
	}

	// Live socket force-closed: its frame channel closes.
	waitFor(t, "live socket force-disconnect", 3*time.Second, func() bool {
		select {
		case _, ok := <-live.frames:
			return !ok
		default:
			return false
		}
	})

	var (
		dbEndedAt   *time.Time
		dbReason    string
		summary     string
		eventExists bool
	)
	waitFor(t, "visit row ended + console event row", 3*time.Second, func() bool {
		_ = ts.pool.QueryRow(ctx,
			`SELECT ended_at, ended_reason FROM agent_visits WHERE id = $1`, visitID).Scan(&dbEndedAt, &dbReason)
		err := ts.pool.QueryRow(ctx,
			`SELECT summary FROM console_events WHERE agent_id = $1`, agentID).Scan(&summary)
		eventExists = err == nil
		return dbEndedAt != nil && eventExists
	})
	if dbReason != "time_expired" {
		t.Fatalf("ended_reason = %q, want time_expired", dbReason)
	}
	if summary != "Visit ended (time expired)" {
		t.Fatalf("console event summary = %q", summary)
	}

	ev := console_.nextFrameOfType(t, verse.EventVisitEnded, 3*time.Second)
	p := framePayload(t, ev)
	if p["agent_id"] != agentID || p["visit_id"] != visitID || p["reason"] != "time_expired" {
		t.Fatalf("visit_ended payload = %v", p)
	}
}

func TestParityVisitActionCap4008(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "CappedVisitAgent", "offline", nil)
	seedVisit(t, ts.pool, agentID, owner, visitSeed{
		endsAt:      time.Now().Add(time.Hour),
		maxActions:  5,
		actionsUsed: 5,
	})
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseVisitEnded {
		t.Fatalf("action-cap close code = %d, want 4008", code)
	}
	var reason string
	if err := ts.pool.QueryRow(context.Background(),
		`SELECT ended_reason FROM agent_visits WHERE agent_id = $1`, agentID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "action_cap" {
		t.Fatalf("ended_reason = %q, want action_cap", reason)
	}
}

// ── replace + identity guard ────────────────────────────────────────────

func TestParityReplace4006AndGuard(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "ReplaceAgent", "offline", nil)

	// Old socket: raw dial (no background reader) so the close code can
	// be read directly off it after the replace.
	ticket1 := seedAgentTicket(t, ts.rdb, agentID)
	dialCtx, dialCancel := context.WithTimeout(ctx, 5*time.Second)
	defer dialCancel()
	oldWs, _, err := websocket.Dial(dialCtx, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket1), nil)
	if err != nil {
		t.Fatalf("dial old: %v", err)
	}
	defer oldWs.CloseNow()
	_, firstFrame, err := oldWs.Read(ctx)
	if err != nil || frameType(t, firstFrame) != verse.EventAgentConnected {
		t.Fatalf("old conn first frame = %s (err=%v)", firstFrame, err)
	}

	neu := connectAgent(t, ts, agentID)

	// The replace closed the old socket with exactly 4006.
	_, _, err = oldWs.Read(ctx)
	if code := websocket.CloseStatus(err); int(code) != CloseReplaced {
		t.Fatalf("old socket close code = %v, want 4006 (err=%v)", code, err)
	}

	// The old socket's async cleanup must not clobber the new conn's
	// presence or DB status (the identity guard's whole job).
	time.Sleep(300 * time.Millisecond)
	if exists, _ := ts.rdb.Exists(ctx, verse.PresenceKey(agentID)).Result(); exists != 1 {
		t.Fatal("presence cleared by replaced socket's cleanup")
	}
	var status string
	if err := ts.pool.QueryRow(ctx, `SELECT status::text FROM agents WHERE id = $1`, agentID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "online" {
		t.Fatalf("DB status = %q after replace, want online", status)
	}

	// The new conn is fully functional: a pong still refreshes presence.
	if err := ts.rdb.Expire(ctx, verse.PresenceKey(agentID), 30*time.Second).Err(); err != nil {
		t.Fatal(err)
	}
	neu.send(t, verse.NewEnvelope(verse.EventPong, map[string]any{}))
	waitFor(t, "new conn pong refreshes presence", 3*time.Second, func() bool {
		ttl, _ := ts.rdb.PTTL(ctx, verse.PresenceKey(agentID)).Result()
		return ttl > 60*time.Second
	})
	neu.ws.CloseNow()
}

// ── presence digest on join + console status (FANOUT_FIX_SPEC) ─────────

func TestParityPresenceDigestOnJoin(t *testing.T) {
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = 100 * time.Millisecond })
	ownerA := seedOwner(t, ts.pool)
	ownerB := seedOwner(t, ts.pool)
	agentA := seedAgent(t, ts.pool, &ownerA, "ParityJoinA", "offline", []string{"chat", "code"})
	agentB := seedAgent(t, ts.pool, &ownerB, "ParityJoinB", "offline", nil)
	// WI-3: digests reach room co-members only — A and B share a room
	// (seeded before connect, so both room sets populate at the live
	// transition).
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, agentA, base, base)
	seedParticipant(t, ts.pool, convID, agentB, base, base)

	consoleA := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, seedOwnerTicket(t, ts.rdb, ownerA)))
	b := connectAgent(t, ts, agentB)
	b.collectFrames(300 * time.Millisecond) // drain B's own join digest (self-stripped → empty)

	a := connectAgent(t, ts, agentA)
	defer a.ws.CloseNow()

	// B receives ONE presence_digest containing A's join — and no
	// individual agent_joined frame, ever.
	ev := b.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second)
	joined, left := digestLists(t, ev)
	if len(joined) != 1 || len(left) != 0 {
		t.Fatalf("digest = joined %v left %v, want exactly A's join", joined, left)
	}
	j := joined[0]
	if j["agent_id"] != agentA || j["name"] != "ParityJoinA" {
		t.Fatalf("digest joined entry = %v", j)
	}
	caps, _ := j["capabilities"].([]any)
	if len(caps) != 2 || caps[0] != "chat" || caps[1] != "code" {
		t.Fatalf("digest joined capabilities = %v", j["capabilities"])
	}
	for _, raw := range b.collectFrames(300 * time.Millisecond) {
		if frameType(t, raw) == verse.EventAgentJoined || frameType(t, raw) == verse.EventAgentLeft {
			t.Fatalf("individual presence frame delivered after digest: %s", raw)
		}
	}

	// A's owner console still sees agent_status_changed online, per-event.
	ev = consoleA.nextFrameOfType(t, verse.EventAgentStatusChanged, 3*time.Second)
	p := framePayload(t, ev)
	if p["agent_id"] != agentA || p["status"] != "online" {
		t.Fatalf("agent_status_changed payload = %v", p)
	}

	// A never sees its own id in a digest (self-strip; a digest holding
	// only A is not written to A at all).
	for _, raw := range a.collectFrames(300 * time.Millisecond) {
		if frameType(t, raw) != verse.EventPresenceDigest {
			continue
		}
		joined, left := digestLists(t, raw)
		for _, e := range joined {
			if e["agent_id"] == agentA {
				t.Fatal("agent saw its own join in a digest")
			}
		}
		for _, e := range left {
			if e["agent_id"] == agentA {
				t.Fatal("agent saw its own id in a digest left list")
			}
		}
	}
}

// ── disconnect semantics (§5) ───────────────────────────────────────────

func TestParityDisconnectSemantics(t *testing.T) {
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = 100 * time.Millisecond })
	ctx := context.Background()
	ownerA := seedOwner(t, ts.pool)
	ownerB := seedOwner(t, ts.pool)
	agentA := seedAgent(t, ts.pool, &ownerA, "WatchAgent", "offline", nil)
	agentB := seedAgent(t, ts.pool, &ownerB, "LeaveAgent", "offline", nil)
	// WI-3: the departure digest reaches room co-members only — A and
	// B share a room.
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, agentA, base, base)
	seedParticipant(t, ts.pool, convID, agentB, base, base)

	consoleB := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, seedOwnerTicket(t, ts.rdb, ownerB)))
	a := connectAgent(t, ts, agentA)
	b := connectAgent(t, ts, agentB)
	a.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second) // drain B's join digest
	consoleB.collectFrames(200 * time.Millisecond)

	b.ws.Close(websocket.StatusNormalClosure, "normal close")

	// A sees B's departure in a presence_digest left list — never as an
	// individual agent_left frame.
	ev := a.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second)
	_, left := digestLists(t, ev)
	if len(left) != 1 || left[0]["agent_id"] != agentB {
		t.Fatalf("disconnect digest left = %v, want exactly B", left)
	}
	// B's console sees status offline.
	ev = consoleB.nextFrameOfType(t, verse.EventAgentStatusChanged, 3*time.Second)
	p := framePayload(t, ev)
	if p["agent_id"] != agentB || p["status"] != "offline" {
		t.Fatalf("console offline payload = %v", p)
	}
	// Presence gone, DB status offline.
	waitFor(t, "B presence cleared + DB offline", 3*time.Second, func() bool {
		exists, _ := ts.rdb.Exists(ctx, verse.PresenceKey(agentB)).Result()
		var status string
		_ = ts.pool.QueryRow(ctx, `SELECT status::text FROM agents WHERE id = $1`, agentB).Scan(&status)
		return exists == 0 && status == "offline"
	})

	// Deliberate status guard: an agent paused WHILE connected keeps
	// 'paused' when its socket closes.
	agentC := seedAgent(t, ts.pool, &ownerA, "PausedMidSession", "offline", nil)
	c := connectAgent(t, ts, agentC)
	if _, err := ts.pool.Exec(ctx, `UPDATE agents SET status = 'paused' WHERE id = $1`, agentC); err != nil {
		t.Fatal(err)
	}
	c.ws.CloseNow()
	time.Sleep(400 * time.Millisecond)
	var status string
	if err := ts.pool.QueryRow(ctx, `SELECT status::text FROM agents WHERE id = $1`, agentC).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "paused" {
		t.Fatalf("status after close = %q, want paused (deliberate states survive close)", status)
	}
	a.ws.CloseNow()
}

// ── heartbeat ───────────────────────────────────────────────────────────

func TestParityHeartbeatTimeout4002(t *testing.T) {
	ts := startTestServer(t)
	ts.srv.heartbeatInterval = 120 * time.Millisecond
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "HeartbeatAgent", "offline", nil)

	ticket := seedAgentTicket(t, ts.rdb, agentID)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.CloseNow()

	// Never pong. Expect: agent_connected, then ping envelopes, then a
	// 4002 close on the third tick (missed 0→1, 1→2, 2>=2 → close).
	sawPing := false
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			if code := websocket.CloseStatus(err); int(code) != CloseHeartbeatTimeout {
				t.Fatalf("close code = %v, want 4002 (err=%v)", code, err)
			}
			break
		}
		var f struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &f)
		if f.Type == verse.EventPing {
			sawPing = true
		}
	}
	if !sawPing {
		t.Fatal("no ping envelope received before the heartbeat timeout")
	}
}

// ── backlog: Postgres path ──────────────────────────────────────────────

func TestParityBacklogFromPostgres(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "BacklogSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "BacklogRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)
	seedParticipant(t, ts.pool, conv, sender, base, base)

	// Before the cursor: not delivered. Own message: not delivered.
	seedMessage(t, ts.pool, conv, sender, "before cursor", base.Add(-time.Second))
	m1 := seedMessage(t, ts.pool, conv, sender, "first for you", base.Add(time.Second))
	m2 := seedMessage(t, ts.pool, conv, sender, "second for you", base.Add(2*time.Second))
	seedMessage(t, ts.pool, conv, recipient, "my own words", base.Add(3*time.Second))

	c := connectAgent(t, ts, recipient)
	frames := c.collectFrames(800 * time.Millisecond)
	msgs := messageFrames(frames)
	if len(msgs) != 2 {
		t.Fatalf("backlog messages = %d, want 2 (%v)", len(msgs), msgs)
	}
	// Oldest-first on the wire, exact payload shape of the PG path.
	if msgs[0]["content"] != "first for you" || msgs[1]["content"] != "second for you" {
		t.Fatalf("backlog order/content = %v", msgs)
	}
	p0 := msgs[0]
	if p0["conversation_id"] != conv || p0["message_id"] != m1 || p0["sender_id"] != sender {
		t.Fatalf("backlog payload ids = %v", p0)
	}
	if p0["reply_to_id"] != nil {
		t.Fatalf("reply_to_id = %v, want null", p0["reply_to_id"])
	}
	if _, isNum := p0["ts"].(float64); !isNum {
		t.Fatalf("ts is %T, want number", p0["ts"])
	}
	_ = m2
	c.ws.CloseNow()
}

func TestParityBacklogTasksAndJoins(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	caller := seedAgent(t, ts.pool, &owner, "TaskCaller", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "TaskRecipient", "offline", nil)
	joiner := seedAgent(t, ts.pool, &owner, "LateJoiner", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)
	// Joiner joins the same conversation AFTER recipient's cursor.
	seedParticipant(t, ts.pool, conv, joiner, base.Add(time.Second), base.Add(time.Second))
	taskID := seedTask(t, ts.pool, recipient, caller, map[string]any{"text": "while you were out"})

	c := connectAgent(t, ts, recipient)
	frames := c.collectFrames(800 * time.Millisecond)

	var sawJoin, sawTask bool
	for _, raw := range frames {
		var f struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			continue
		}
		switch f.Type {
		case verse.EventThreadParticipantJoin:
			if f.Payload["conversation_id"] == conv && f.Payload["agent_id"] == joiner && f.Payload["invited_by"] == nil {
				sawJoin = true
			}
		case verse.EventA2ATaskRequest:
			msg, _ := f.Payload["message"].(map[string]any)
			if f.Payload["taskId"] == taskID && f.Payload["fromAgentId"] == caller && msg["text"] == "while you were out" {
				sawTask = true
			}
		}
	}
	if !sawJoin {
		t.Fatal("thread_participant_joined missing from backlog")
	}
	if !sawTask {
		t.Fatal("a2a_task_request missing from backlog")
	}
	c.ws.CloseNow()
}

// ── backlog: recent-cache path ──────────────────────────────────────────

func TestParityBacklogFromCache(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "CacheSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "CacheRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	ownAt := base.Add(time.Second)
	seedParticipant(t, ts.pool, conv, recipient, base, ownAt)

	ownID := seedMessage(t, ts.pool, conv, recipient, "my own words", ownAt)
	m1At := base.Add(2 * time.Second)
	m2At := base.Add(3 * time.Second)
	m1 := seedMessage(t, ts.pool, conv, sender, "first for you", m1At)
	m2 := seedMessage(t, ts.pool, conv, sender, "second for you", m2At)

	// Cache holds all three, newest-first — then the PG rows vanish, so
	// only the cache can serve this backlog.
	key := verse.RecentCacheKey(conv)
	for _, e := range []string{
		cacheEntryJSON(m2, conv, sender, "second for you", m2At.UnixMilli()),
		cacheEntryJSON(m1, conv, sender, "first for you", m1At.UnixMilli()),
		cacheEntryJSON(ownID, conv, recipient, "my own words", ownAt.UnixMilli()),
	} {
		if err := ts.rdb.RPush(ctx, key, e).Err(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ts.pool.Exec(ctx, `DELETE FROM messages WHERE conversation_id = $1`, conv); err != nil {
		t.Fatal(err)
	}

	c := connectAgent(t, ts, recipient)
	frames := c.collectFrames(800 * time.Millisecond)
	msgs := messageFrames(frames)
	if len(msgs) != 2 || msgs[0]["content"] != "first for you" || msgs[1]["content"] != "second for you" {
		t.Fatalf("cache backlog = %v, want [first second] oldest-first, own excluded", msgs)
	}
	if msgs[0]["message_id"] != m1 || msgs[0]["sender_id"] != sender || msgs[0]["reply_to_id"] != nil {
		t.Fatalf("cache payload shape = %v", msgs[0])
	}
	if int64(msgs[0]["ts"].(float64)) != m1At.UnixMilli() {
		t.Fatalf("cache ts = %v, want %d", msgs[0]["ts"], m1At.UnixMilli())
	}
	c.ws.CloseNow()
}

func TestParityCacheCoverageFailureFallsBack(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "FallbackSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "FallbackRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	// Cursor two hours back; the cache will only hold a NEW message, so
	// its oldest entry is after the cursor — coverage proof fails.
	base := time.Now().Add(-2 * time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)
	ancientAt := base.Add(time.Hour)
	seedMessage(t, ts.pool, conv, sender, "ancient message", ancientAt)
	newAt := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	newID := seedMessage(t, ts.pool, conv, sender, "new message", newAt)
	if err := ts.rdb.RPush(ctx, verse.RecentCacheKey(conv),
		cacheEntryJSON(newID, conv, sender, "new message", newAt.UnixMilli())).Err(); err != nil {
		t.Fatal(err)
	}

	c := connectAgent(t, ts, recipient)
	frames := c.collectFrames(800 * time.Millisecond)
	msgs := messageFrames(frames)
	var contents []string
	for _, m := range msgs {
		contents = append(contents, m["content"].(string))
	}
	if len(contents) != 2 || contents[0] != "ancient message" || contents[1] != "new message" {
		t.Fatalf("fallback backlog = %v, want [ancient new] from Postgres", contents)
	}
	c.ws.CloseNow()

	// Malformed cache entry: coverage proof is void → Postgres again.
	recipient2 := seedAgent(t, ts.pool, &owner, "MalformedRecipient", "offline", nil)
	conv2 := seedConversation(t, ts.pool)
	seedParticipant(t, ts.pool, conv2, recipient2, base, base)
	seedMessage(t, ts.pool, conv2, sender, "pg only message", ancientAt)
	if err := ts.rdb.RPush(ctx, verse.RecentCacheKey(conv2), "not-json{{{").Err(); err != nil {
		t.Fatal(err)
	}
	c2 := connectAgent(t, ts, recipient2)
	frames2 := c2.collectFrames(800 * time.Millisecond)
	msgs2 := messageFrames(frames2)
	if len(msgs2) != 1 || msgs2[0]["content"] != "pg only message" {
		t.Fatalf("malformed-cache fallback backlog = %v", msgs2)
	}
	c2.ws.CloseNow()
}

// ── backlog: pending-ingest merge ───────────────────────────────────────

func TestParityPendingIngestInclusionDedupe(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "RaceSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "RaceRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)
	persisted := seedMessage(t, ts.pool, conv, sender, "already persisted", base.Add(time.Second))

	// Stream tail: the persisted message's twin (consumer raced us) AND
	// a stream-only message. Neither is in the recent cache.
	streamOnly := uuid.NewString()
	for _, e := range []struct {
		id, content string
		at          time.Time
	}{
		{persisted, "already persisted", base.Add(time.Second)},
		{streamOnly, "racing the persist window", base.Add(2 * time.Second)},
	} {
		xaddIngest(t, ts, map[string]any{
			"id": e.id, "conversationId": conv, "senderAgentId": sender,
			"content": e.content, "replyToId": "", "clientMessageId": "",
			"runId": "", "isPublic": "0", "attachments": "[]", "mentions": "[]",
			"ts": fmt.Sprint(e.at.UnixMilli()),
		})
	}

	c := connectAgent(t, ts, recipient)
	frames := c.collectFrames(900 * time.Millisecond)
	msgs := messageFrames(frames)
	if len(msgs) != 2 {
		t.Fatalf("merged backlog = %v, want exactly 2 (persisted once + stream-only)", msgs)
	}
	if msgs[0]["message_id"] != persisted || msgs[1]["message_id"] != streamOnly {
		t.Fatalf("merged backlog order = %v", msgs)
	}
	if msgs[1]["content"] != "racing the persist window" {
		t.Fatalf("stream-only content = %v", msgs[1]["content"])
	}
	c.ws.CloseNow()
}

func TestParityPendingMentionMerge(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "MentionRaceSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "MentionRaceTarget", "offline", nil)
	conv := seedConversation(t, ts.pool)

	msgID := uuid.NewString()
	mentionID := uuid.NewString()
	mentionsJSON, _ := json.Marshal([]map[string]any{{
		"id": mentionID, "targetAgentId": recipient, "byAgentId": sender,
		"byName": "MentionRaceSender", "conversationId": conv, "messageId": msgID,
		"isPublic": true, "roomSlug": nil, "content": "hey @MentionRaceTarget look",
	}})
	xaddIngest(t, ts, map[string]any{
		"id": msgID, "conversationId": conv, "senderAgentId": sender,
		"content": "hey @MentionRaceTarget look", "replyToId": "", "clientMessageId": "",
		"runId": "", "isPublic": "1", "attachments": "[]", "mentions": string(mentionsJSON),
		"ts": fmt.Sprint(time.Now().UnixMilli()),
	})

	// No mention row in Postgres — the backlog must merge it from the
	// stream with its pre-generated id.
	c := connectAgent(t, ts, recipient)
	ev := c.nextFrameOfType(t, verse.EventMentioned, 3*time.Second)
	p := framePayload(t, ev)
	if p["mention_id"] != mentionID || p["message_id"] != msgID || p["by_name"] != "MentionRaceSender" {
		t.Fatalf("pending mention payload = %v", p)
	}
	c.ws.CloseNow()
}

// ── acks ────────────────────────────────────────────────────────────────

func TestParityMessageAckAdvancesCursor(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "AckSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "AckRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)
	m1At := base.Add(time.Second)
	m2At := base.Add(2 * time.Second)
	m1 := seedMessage(t, ts.pool, conv, sender, "ack one", m1At)
	m2 := seedMessage(t, ts.pool, conv, sender, "ack two", m2At)

	cursorMs := func() int64 {
		var ms int64
		err := ts.pool.QueryRow(ctx,
			`SELECT (extract(epoch FROM last_delivered_at) * 1000)::bigint
			 FROM conversation_participants WHERE conversation_id = $1 AND agent_id = $2`,
			conv, recipient).Scan(&ms)
		if err != nil {
			t.Fatal(err)
		}
		return ms
	}

	c := connectAgent(t, ts, recipient)
	c.collectFrames(500 * time.Millisecond) // drain backlog

	// Ack the NEWER message first: cursor jumps to it.
	c.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"conversationId": conv, "messageId": m2}))
	waitFor(t, "cursor advanced to m2", 3*time.Second, func() bool {
		return cursorMs() == m2At.UnixMilli()
	})
	// Acking the older one must not move the cursor backward.
	c.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"conversationId": conv, "messageId": m1}))
	time.Sleep(300 * time.Millisecond)
	if got := cursorMs(); got != m2At.UnixMilli() {
		t.Fatalf("cursor after out-of-order ack = %d, want %d (never backward)", got, m2At.UnixMilli())
	}
	c.ws.CloseNow()
	time.Sleep(150 * time.Millisecond)

	// Reconnect: nothing redelivers — the cursor is past both.
	c2 := connectAgent(t, ts, recipient)
	if msgs := messageFrames(c2.collectFrames(700 * time.Millisecond)); len(msgs) != 0 {
		t.Fatalf("redelivery after ack: %v", msgs)
	}
	c2.ws.CloseNow()
}

func TestParityMentionAck(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "MentionAckSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "MentionAckTarget", "offline", nil)
	conv := seedConversation(t, ts.pool)

	at := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	msgID := seedMessage(t, ts.pool, conv, sender, "ping @MentionAckTarget", at)
	mentionID := seedMention(t, ts.pool, recipient, sender, "MentionAckSender", conv, msgID, "ping @MentionAckTarget", at)

	c := connectAgent(t, ts, recipient)
	ev := c.nextFrameOfType(t, verse.EventMentioned, 3*time.Second)
	if framePayload(t, ev)["mention_id"] != mentionID {
		t.Fatalf("backlog mention = %v", framePayload(t, ev))
	}

	c.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"mentionId": mentionID}))
	waitFor(t, "mentions.acked_at set", 3*time.Second, func() bool {
		var acked *time.Time
		_ = ts.pool.QueryRow(ctx, `SELECT acked_at FROM mentions WHERE id = $1`, mentionID).Scan(&acked)
		return acked != nil
	})
	c.ws.CloseNow()
	time.Sleep(150 * time.Millisecond)

	// Reconnect: the acked mention is not redelivered.
	c2 := connectAgent(t, ts, recipient)
	for _, raw := range c2.collectFrames(700 * time.Millisecond) {
		if frameType(t, raw) == verse.EventMentioned {
			t.Fatalf("acked mention redelivered: %s", raw)
		}
	}
	c2.ws.CloseNow()
}

func TestParityEarlyAckFilter(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "EarlyAckSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "EarlyAckRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)

	// Recipient is live; a message fans out to it; it acks BEFORE the row
	// exists (the async persist window) — the ack must be stashed, and
	// once the row lands, the backlog must filter it out.
	msgID := uuid.NewString()
	c := connectAgent(t, ts, recipient)
	ts.srv.PublishFanout(ctx, verse.FanoutMessage{
		Kind:    "agent",
		AgentID: recipient,
		Event: verse.NewEnvelope(verse.EventMessage, map[string]any{
			"conversation_id": conv, "message_id": msgID, "sender_id": sender,
			"content": "early ack race message", "reply_to_id": nil, "ts": base.Add(time.Second).UnixMilli(),
		}).Bytes(),
	})
	got := c.nextFrameOfType(t, verse.EventMessage, 3*time.Second)
	if framePayload(t, got)["message_id"] != msgID {
		t.Fatalf("live push = %v", framePayload(t, got))
	}
	c.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"conversationId": conv, "messageId": msgID}))
	waitFor(t, "early-ack stash written", 3*time.Second, func() bool {
		n, _ := ts.rdb.Exists(ctx, verse.EarlyAckMsgKey(conv, recipient, msgID)).Result()
		return n == 1
	})
	c.ws.CloseNow()
	time.Sleep(150 * time.Millisecond)

	// The row now persists (still "unacked" — the stash is the only record).
	seedMessageWithID(t, ts.pool, msgID, conv, sender, "early ack race message", base.Add(time.Second))

	c2 := connectAgent(t, ts, recipient)
	if msgs := messageFrames(c2.collectFrames(800 * time.Millisecond)); len(msgs) != 0 {
		t.Fatalf("early-acked message redelivered: %v", msgs)
	}
	c2.ws.CloseNow()

	// Mention variant: ack an unpersisted mention, then the row lands
	// WITH the pre-generated id — the stash must filter it from backlog.
	mentionID := uuid.NewString()
	hostMsg := seedMessage(t, ts.pool, conv, sender, "host for mention", base.Add(2*time.Second))
	c3 := connectAgent(t, ts, recipient)
	c3.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"mentionId": mentionID}))
	waitFor(t, "early-ack mention stash written", 3*time.Second, func() bool {
		n, _ := ts.rdb.Exists(ctx, verse.EarlyAckMentionKey(mentionID)).Result()
		return n == 1
	})
	c3.ws.CloseNow()
	time.Sleep(150 * time.Millisecond)
	_, err := ts.pool.Exec(ctx,
		`INSERT INTO mentions (id, target_agent_id, by_agent_id, by_name, conversation_id, message_id, is_public, content, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)`,
		mentionID, recipient, sender, "EarlyAckSender", conv, hostMsg, "host for mention", base.Add(2*time.Second))
	if err != nil {
		t.Fatalf("seed mention with id: %v", err)
	}
	c4 := connectAgent(t, ts, recipient)
	for _, raw := range c4.collectFrames(800 * time.Millisecond) {
		if frameType(t, raw) == verse.EventMentioned {
			t.Fatalf("early-acked mention redelivered: %s", raw)
		}
	}
	c4.ws.CloseNow()
}

// ── console / public ────────────────────────────────────────────────────

func TestParityConsoleRoute(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)

	// Bad ticket → 4001.
	if code := dialExpectClose(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, uuid.NewString())); code != CloseInvalidTicket {
		t.Fatalf("console bad ticket close = %d, want 4001", code)
	}

	// Two sockets for one owner both receive console fanout.
	s1 := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, seedOwnerTicket(t, ts.rdb, owner)))
	s2 := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, seedOwnerTicket(t, ts.rdb, owner)))
	time.Sleep(200 * time.Millisecond) // let both register
	ev := verse.NewEnvelope(verse.EventAgentStatusChanged, map[string]any{"marker": "both"}).Bytes()
	ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "console", OwnerID: owner, Event: ev})
	for _, s := range []*testClient{s1, s2} {
		got := s.nextFrame(t, 3*time.Second)
		if !strings.Contains(string(got), "both") {
			t.Fatalf("console socket got %s", got)
		}
	}

	// Closing one leaves the other subscribed (per-socket removal).
	s1.ws.CloseNow()
	time.Sleep(200 * time.Millisecond)
	ev2 := verse.NewEnvelope(verse.EventAgentStatusChanged, map[string]any{"marker": "second-only"}).Bytes()
	ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "console", OwnerID: owner, Event: ev2})
	got := s2.nextFrame(t, 3*time.Second)
	if !strings.Contains(string(got), "second-only") {
		t.Fatalf("surviving console socket got %s", got)
	}
	s2.ws.CloseNow()
}

func TestParityPublicRoute(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	pub := dial(t, fmt.Sprintf("%s/public/ws", ts.url))
	other := dial(t, fmt.Sprintf("%s/public/ws", ts.url))
	time.Sleep(200 * time.Millisecond)
	ev := verse.NewEnvelope(verse.EventPublicMessage, map[string]any{"marker": "for-public"}).Bytes()
	ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "public", Event: ev})
	for _, c := range []*testClient{pub, other} {
		got := c.nextFrame(t, 3*time.Second)
		if !strings.Contains(string(got), "for-public") {
			t.Fatalf("public socket got %s", got)
		}
	}
	pub.ws.CloseNow()
	other.ws.CloseNow()
}

// ── fanout golden shapes (§8/§10) ───────────────────────────────────────

func TestParityFanoutGoldenShapes(t *testing.T) {
	env := verse.Envelope{
		Type:    "agent_joined",
		ID:      "11111111-1111-1111-1111-111111111111",
		Ts:      1700000000000,
		Payload: json.RawMessage(`{"agent_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"N","capabilities":["x"]}`),
	}
	envJSON := `{"type":"agent_joined","id":"11111111-1111-1111-1111-111111111111","ts":1700000000000,"payload":{"agent_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"N","capabilities":["x"]}}`
	cases := []struct {
		name string
		msg  verse.FanoutMessage
		want string
	}{
		{"agent", verse.FanoutMessage{Kind: "agent", AgentID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Event: env.Bytes()},
			`{"kind":"agent","agentId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","event":` + envJSON + `}`},
		{"broadcast", verse.FanoutMessage{Kind: "broadcast", ExceptAgentID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", Event: env.Bytes()},
			`{"kind":"broadcast","event":` + envJSON + `,"exceptAgentId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}`},
		{"console", verse.FanoutMessage{Kind: "console", OwnerID: "cccccccc-cccc-cccc-cccc-cccccccccccc", Event: env.Bytes()},
			`{"kind":"console","ownerId":"cccccccc-cccc-cccc-cccc-cccccccccccc","event":` + envJSON + `}`},
		{"public", verse.FanoutMessage{Kind: "public", Event: env.Bytes()},
			`{"kind":"public","event":` + envJSON + `}`},
	}
	for _, tc := range cases {
		raw, err := json.Marshal(tc.msg)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != tc.want {
			t.Fatalf("%s fanout shape:\n got %s\nwant %s", tc.name, raw, tc.want)
		}
	}

	// Originated payload key order (TS object literals).
	joined := verse.NewEnvelope(verse.EventAgentJoined, agentJoinedPayload{
		AgentID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Name: "N", Capabilities: []string{},
	})
	if string(joined.Payload) != `{"agent_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"N","capabilities":[]}` {
		t.Fatalf("agent_joined payload = %s (capabilities must be [], not null)", joined.Payload)
	}
	status := verse.NewEnvelope(verse.EventAgentStatusChanged, agentStatusChangedPayload{AgentID: "a", Status: "online"})
	if string(status.Payload) != `{"agent_id":"a","status":"online"}` {
		t.Fatalf("agent_status_changed payload = %s", status.Payload)
	}
	visit := verse.NewEnvelope(verse.EventVisitEnded, visitEndedPayload{AgentID: "a", VisitID: "v", Reason: "time_expired"})
	if string(visit.Payload) != `{"agent_id":"a","visit_id":"v","reason":"time_expired"}` {
		t.Fatalf("visit_ended payload = %s", visit.Payload)
	}

	// presence_digest (FANOUT_FIX_SPEC): payload key order joined→left,
	// entries reuse the agent_joined/agent_left payload shapes, and the
	// fanout message is a bare broadcast — no exceptAgentId; delivery
	// strips each receiver's own id instead.
	digestEnv := verse.Envelope{
		Type:    verse.EventPresenceDigest,
		ID:      "11111111-1111-1111-1111-111111111111",
		Ts:      1700000000000,
		Payload: json.RawMessage(`{"joined":[{"agent_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"N","capabilities":["x"]}],"left":[{"agent_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}]}`),
	}
	digestJSON := `{"type":"presence_digest","id":"11111111-1111-1111-1111-111111111111","ts":1700000000000,"payload":{"joined":[{"agent_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"N","capabilities":["x"]}],"left":[{"agent_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}]}}`
	if got := string(digestEnv.Bytes()); got != digestJSON {
		t.Fatalf("digest envelope:\n got %s\nwant %s", got, digestJSON)
	}
	digestFanout, err := json.Marshal(verse.FanoutMessage{Kind: "broadcast", Event: digestEnv.Bytes()})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"kind":"broadcast","event":` + digestJSON + `}`; string(digestFanout) != want {
		t.Fatalf("digest fanout:\n got %s\nwant %s", digestFanout, want)
	}
	// A flush-shaped payload: an empty side marshals as [], never null;
	// WI-3 entries carry their rooms snapshot (always present, [] when
	// the subject shares no room), stripped again before the wire.
	flushPayload := verse.NewEnvelope(verse.EventPresenceDigest, presenceDigestPayload{
		Joined: []digestJoinedEntry{{AgentID: "a", Name: "N", Capabilities: []string{}, Rooms: []string{}}},
		Left:   []digestLeftEntry{},
	})
	if string(flushPayload.Payload) != `{"joined":[{"agent_id":"a","name":"N","capabilities":[],"rooms":[]}],"left":[]}` {
		t.Fatalf("digest payload = %s", flushPayload.Payload)
	}
	// WI-3 room-scoped broadcast: roomConversationId rides after
	// exceptAgentId, matching the TS publish literal's key order.
	roomFanout, err := json.Marshal(verse.FanoutMessage{
		Kind: "broadcast", ExceptAgentID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		RoomConversationID: "dddddddd-dddd-dddd-dddd-dddddddddddd", Event: env.Bytes(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"kind":"broadcast","event":` + envJSON + `,"exceptAgentId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","roomConversationId":"dddddddd-dddd-dddd-dddd-dddddddddddd"}`; string(roomFanout) != want {
		t.Fatalf("room-scoped fanout:\n got %s\nwant %s", roomFanout, want)
	}
}

// ── boot reconcile (§9) ─────────────────────────────────────────────────

func TestParityBootReconcile(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	stuck := seedAgent(t, ts.pool, &owner, "StuckOnline", "online", nil)
	alive := seedAgent(t, ts.pool, &owner, "AliveOnline", "online", nil)
	if err := ts.rdb.Set(ctx, verse.PresenceKey(alive), "1", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}

	if _, err := ts.srv.ReconcilePresenceOnBoot(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	statusOf := func(id string) string {
		var s string
		if err := ts.pool.QueryRow(ctx, `SELECT status::text FROM agents WHERE id = $1`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if got := statusOf(stuck); got != "offline" {
		t.Fatalf("stuck agent status = %q, want offline", got)
	}
	if got := statusOf(alive); got != "online" {
		t.Fatalf("live agent status = %q, want online (presence key protects it)", got)
	}
}

// ── register-first proof (§2/§10) ───────────────────────────────────────

func TestParityRegisterFirstSlowBacklog(t *testing.T) {
	ts := startTestServer(t)
	ts.srv.backlogDelay = 900 * time.Millisecond
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "SlowSender", "offline", nil)
	recipient := seedAgent(t, ts.pool, &owner, "SlowRecipient", "offline", nil)
	conv := seedConversation(t, ts.pool)

	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, conv, recipient, base, base)
	ids := make([]string, 3)
	for i, content := range []string{"backlog one", "backlog two", "backlog three"} {
		ids[i] = seedMessage(t, ts.pool, conv, sender, content, base.Add(time.Duration(i+1)*time.Second))
	}

	ticket := seedAgentTicket(t, ts.rdb, recipient)
	c := dial(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))

	// Mid-setup (backlog deliberately slowed): a live message, a fanout
	// duplicate of a backlog message, and a non-message event all target
	// the still-setting-up conn. All must buffer.
	time.Sleep(250 * time.Millisecond)
	liveEnv := verse.NewEnvelope(verse.EventMessage, map[string]any{
		"conversation_id": conv, "message_id": uuid.NewString(), "sender_id": sender,
		"content": "live during setup", "reply_to_id": nil, "ts": base.Add(10 * time.Second).UnixMilli(),
	})
	dupEnv := verse.NewEnvelope(verse.EventMessage, map[string]any{
		"conversation_id": conv, "message_id": ids[1], "sender_id": sender,
		"content": "backlog two", "reply_to_id": nil, "ts": base.Add(2 * time.Second).UnixMilli(),
	})
	otherEnv := verse.NewEnvelope(verse.EventRateLimited, map[string]any{"marker": "buffered-other"})
	for _, env := range []verse.Envelope{liveEnv, dupEnv, otherEnv} {
		ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "agent", AgentID: recipient, Event: env.Bytes()})
	}

	// Expected wire order: agent_connected, the three backlog messages
	// oldest-first, then the buffered frames in arrival order — with the
	// backlog duplicate appearing exactly once (its backlog position).
	frames := c.collectFrames(3 * time.Second)
	type frameID struct {
		typ     string
		content string
		msgID   string
		marker  string
	}
	var got []frameID
	for _, raw := range frames {
		var f struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			continue
		}
		fi := frameID{typ: f.Type}
		if f.Payload != nil {
			fi.content, _ = f.Payload["content"].(string)
			fi.msgID, _ = f.Payload["message_id"].(string)
			fi.marker, _ = f.Payload["marker"].(string)
		}
		got = append(got, fi)
	}
	want := []frameID{
		{typ: verse.EventAgentConnected},
		{typ: verse.EventMessage, content: "backlog one", msgID: ids[0]},
		{typ: verse.EventMessage, content: "backlog two", msgID: ids[1]},
		{typ: verse.EventMessage, content: "backlog three", msgID: ids[2]},
		{typ: verse.EventMessage, content: "live during setup"},
		{typ: verse.EventRateLimited, marker: "buffered-other"},
	}
	if len(got) != len(want) {
		t.Fatalf("frames = %+v, want %d frames in backlog-then-buffer order", got, len(want))
	}
	for i := range want {
		if got[i].typ != want[i].typ || got[i].content != want[i].content || got[i].marker != want[i].marker {
			t.Fatalf("frame %d = %+v, want %+v (all: %+v)", i, got[i], want[i], got)
		}
		if want[i].msgID != "" && got[i].msgID != want[i].msgID {
			t.Fatalf("frame %d msgID = %q, want %q", i, got[i].msgID, want[i].msgID)
		}
	}
	c.ws.CloseNow()
}

// ── presence digests (FANOUT_FIX_SPEC) ──────────────────────────────────

// digestLists extracts the joined/left entry lists from a digest frame.
func digestLists(t *testing.T, raw []byte) (joined, left []map[string]any) {
	t.Helper()
	if got := frameType(t, raw); got != verse.EventPresenceDigest {
		t.Fatalf("frame type = %q, want presence_digest (%s)", got, raw)
	}
	p := framePayload(t, raw)
	entries := func(key string) []map[string]any {
		list, _ := p[key].([]any)
		out := make([]map[string]any, 0, len(list))
		for _, e := range list {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return entries("joined"), entries("left")
}

func framesOfType(frames [][]byte, typ string) [][]byte {
	var out [][]byte
	for _, raw := range frames {
		var f struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &f); err == nil && f.Type == typ {
			out = append(out, raw)
		}
	}
	return out
}

func TestDigestNettingJoinThenLeft(t *testing.T) {
	// Window pinned open: nothing flushes until the test flushes by hand.
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = time.Hour })
	owner := seedOwner(t, ts.pool)
	watcher := seedAgent(t, ts.pool, &owner, "DigestWatcher", "offline", nil)
	flap := seedAgent(t, ts.pool, &owner, "DigestFlap", "offline", nil)
	stayer := seedAgent(t, ts.pool, &owner, "DigestStayer", "offline", []string{"chat"})
	// WI-3: entries are attributed to the subjects' room snapshot and
	// reach co-members only — all three share one room.
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	for _, a := range []string{watcher, flap, stayer} {
		seedParticipant(t, ts.pool, convID, a, base, base)
	}
	rooms := []string{convID}

	w := connectAgent(t, ts, watcher)
	w.collectFrames(300 * time.Millisecond) // drain watcher's own (empty) digest state

	ts.srv.recordPresenceJoined(flap, "DigestFlap", nil, rooms)
	ts.srv.recordPresenceLeft(flap, rooms) // join+left in one window → only left survives
	ts.srv.recordPresenceJoined(stayer, "DigestStayer", []string{"chat"}, rooms)
	ts.srv.flushPresenceDigest()

	ev := w.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second)
	joined, left := digestLists(t, ev)
	if len(left) != 1 || left[0]["agent_id"] != flap {
		t.Fatalf("digest left = %v, want exactly the flapped agent", left)
	}
	if len(joined) != 1 || joined[0]["agent_id"] != stayer || joined[0]["name"] != "DigestStayer" {
		t.Fatalf("digest joined = %v, want exactly the stayer", joined)
	}
	if caps, _ := joined[0]["capabilities"].([]any); len(caps) != 1 || caps[0] != "chat" {
		t.Fatalf("digest joined capabilities = %v", joined[0]["capabilities"])
	}
	// Exactly one digest for the whole window.
	if extra := framesOfType(w.collectFrames(300*time.Millisecond), verse.EventPresenceDigest); len(extra) != 0 {
		t.Fatalf("extra digest frames: %q", extra)
	}
	w.ws.CloseNow()
}

func TestDigestNettingLeftThenJoin(t *testing.T) {
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = time.Hour })
	owner := seedOwner(t, ts.pool)
	watcher := seedAgent(t, ts.pool, &owner, "DigestWatcher2", "offline", nil)
	flap := seedAgent(t, ts.pool, &owner, "DigestFlap2", "offline", nil)
	leaver := seedAgent(t, ts.pool, &owner, "DigestLeaver", "offline", nil)
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	for _, a := range []string{watcher, flap, leaver} {
		seedParticipant(t, ts.pool, convID, a, base, base)
	}
	rooms := []string{convID}

	w := connectAgent(t, ts, watcher)
	w.collectFrames(300 * time.Millisecond)

	ts.srv.recordPresenceLeft(flap, rooms)
	ts.srv.recordPresenceJoined(flap, "DigestFlap2", nil, rooms) // left+join → only joined survives
	ts.srv.recordPresenceLeft(leaver, rooms)
	ts.srv.flushPresenceDigest()

	ev := w.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second)
	joined, left := digestLists(t, ev)
	if len(joined) != 1 || joined[0]["agent_id"] != flap {
		t.Fatalf("digest joined = %v, want exactly the re-joined agent", joined)
	}
	if len(left) != 1 || left[0]["agent_id"] != leaver {
		t.Fatalf("digest left = %v, want exactly the leaver", left)
	}
	w.ws.CloseNow()
}

func TestDigestSizeCapFlush(t *testing.T) {
	// Window pinned open, cap at 3: the third pending entry must flush
	// without any window elapsing and without a manual flush.
	ts := startTestServerWith(t, func(s *Server) {
		s.digestWindow = time.Hour
		s.digestMaxPending = 3
	})
	owner := seedOwner(t, ts.pool)
	watcher := seedAgent(t, ts.pool, &owner, "CapWatcher", "offline", nil)
	// WI-3: the joiners' entries must be attributed to a room the
	// watcher shares, or scoping drops them before the cap assertion —
	// and the watcher's room set populates at ITS connect, so the
	// participant row predates it.
	convID := seedConversation(t, ts.pool)
	capBase := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, watcher, capBase, capBase)

	w := connectAgent(t, ts, watcher)
	w.collectFrames(300 * time.Millisecond)
	// The watcher's own join is pending too and would count toward the
	// cap — flush it out first (stripped to nothing for the watcher).
	ts.srv.flushPresenceDigest()
	w.collectFrames(200 * time.Millisecond)

	ids := make([]string, 3)
	for i := range ids {
		ids[i] = seedAgent(t, ts.pool, &owner, fmt.Sprintf("CapJoiner-%d", i), "offline", nil)
		ts.srv.recordPresenceJoined(ids[i], fmt.Sprintf("CapJoiner-%d", i), nil, []string{convID})
	}

	ev := w.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second)
	joined, _ := digestLists(t, ev)
	if len(joined) != 3 {
		t.Fatalf("size-cap digest joined = %v, want all 3 in first-seen order", joined)
	}
	for i, id := range ids {
		if joined[i]["agent_id"] != id {
			t.Fatalf("digest order[%d] = %v, want first-seen order %v", i, joined[i]["agent_id"], ids)
		}
	}
	w.ws.CloseNow()
}

func TestDigestSelfStrip(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	watcher := seedAgent(t, ts.pool, &owner, "StripWatcher", "offline", nil)
	other := seedAgent(t, ts.pool, &owner, "StripOther", "offline", nil)
	third := seedAgent(t, ts.pool, &owner, "StripThird", "offline", nil)

	w := connectAgent(t, ts, watcher)
	w.collectFrames(300 * time.Millisecond) // drain own join digest window

	digestWith := func(joined []agentJoinedPayload, left []agentLeftPayload) []byte {
		if joined == nil {
			joined = []agentJoinedPayload{}
		}
		if left == nil {
			left = []agentLeftPayload{}
		}
		// The pre-WI-3 fanout shape: entries carry NO rooms attribution.
		// scopePresenceDigest treats an unattributed entry as a foreign
		// (mixed-version) shape and delivers it as before — self-strip
		// only, no room scoping.
		type foreignDigest struct {
			Joined []agentJoinedPayload `json:"joined"`
			Left   []agentLeftPayload   `json:"left"`
		}
		return verse.NewEnvelope(verse.EventPresenceDigest,
			foreignDigest{Joined: joined, Left: left}).Bytes()
	}
	publish := func(raw []byte) {
		ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "broadcast", Event: raw})
	}

	// Mixed digest: the receiver's own id is stripped from BOTH lists;
	// everyone else's entries arrive intact.
	publish(digestWith(
		[]agentJoinedPayload{
			{AgentID: watcher, Name: "StripWatcher", Capabilities: []string{}},
			{AgentID: other, Name: "StripOther", Capabilities: []string{}},
		},
		[]agentLeftPayload{{AgentID: watcher}, {AgentID: third}},
	))
	ev := w.nextFrameOfType(t, verse.EventPresenceDigest, 3*time.Second)
	joined, left := digestLists(t, ev)
	if len(joined) != 1 || joined[0]["agent_id"] != other {
		t.Fatalf("stripped joined = %v, want only the other agent", joined)
	}
	if len(left) != 1 || left[0]["agent_id"] != third {
		t.Fatalf("stripped left = %v, want only the third agent", left)
	}

	// A digest containing ONLY the receiver's own id is not written at
	// all — neither the joined-only nor the left-only form.
	publish(digestWith(
		[]agentJoinedPayload{{AgentID: watcher, Name: "StripWatcher", Capabilities: []string{}}}, nil))
	publish(digestWith(nil, []agentLeftPayload{{AgentID: watcher}}))
	for _, raw := range w.collectFrames(500 * time.Millisecond) {
		if frameType(t, raw) == verse.EventPresenceDigest {
			t.Fatalf("only-self digest was written to the socket: %s", raw)
		}
	}
	w.ws.CloseNow()
}

func TestDigestJoinBurstBoundedFrames(t *testing.T) {
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = 150 * time.Millisecond })
	owner := seedOwner(t, ts.pool)
	watcher := seedAgent(t, ts.pool, &owner, "FloodWatcher", "offline", nil)
	// WI-3: the watcher perceives the burst because every joiner
	// shares its room (participant rows predate every connect, so each
	// join entry is attributed to it).
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, watcher, base, base)
	w := connectAgent(t, ts, watcher)
	w.collectFrames(300 * time.Millisecond)

	// A 40-agent join burst: the watcher must see every joiner exactly
	// via digests, in a bounded number of frames — not 40 blasts.
	const n = 40
	clients := make([]*testClient, 0, n)
	for i := 0; i < n; i++ {
		id := seedAgent(t, ts.pool, &owner, fmt.Sprintf("FloodJoiner-%02d", i), "offline", nil)
		seedParticipant(t, ts.pool, convID, id, base, base)
		clients = append(clients, connectAgent(t, ts, id))
	}
	frames := w.collectFrames(2 * time.Second)
	for _, raw := range frames {
		if ft := frameType(t, raw); ft == verse.EventAgentJoined || ft == verse.EventAgentLeft {
			t.Fatalf("individual presence frame under burst: %s", raw)
		}
	}
	digests := framesOfType(frames, verse.EventPresenceDigest)
	seen := make(map[string]bool)
	for _, d := range digests {
		joined, _ := digestLists(t, d)
		for _, e := range joined {
			seen[e["agent_id"].(string)] = true
		}
	}
	if len(seen) != n {
		t.Fatalf("digest coverage = %d distinct joiners, want %d", len(seen), n)
	}
	if len(digests) == 0 || len(digests) > 15 {
		t.Fatalf("digest frames for a %d-join burst = %d, want bounded (1..15), not per-join", n, len(digests))
	}
	for _, c := range clients {
		c.ws.CloseNow()
	}
	w.ws.CloseNow()
}
