package edge

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"aiverse/go-edge/internal/verse"
)

// Cursor acks v1 (PHASE1_SPEC WI-4) — mirrors the TS
// ws/ackCursors.test.ts cases that live on the edge's side of the
// contract: (a) dual writes both stores, (b) redis mode writes no PG
// and every reader sees the cursor immediately, (f) legacy is PG-only.

func pgCursorMs(t *testing.T, ts *testServer, convID, agentID string) int64 {
	t.Helper()
	ms, ok := pgCursorMsOK(ts, convID, agentID)
	if !ok {
		t.Fatalf("read PG cursor for %s/%s", convID, agentID)
	}
	return ms
}

// pgCursorMsOK is the non-fatal poll form for waitFor conditions — a
// transient pool error mid-poll must read as "not yet", not kill the
// test.
func pgCursorMsOK(ts *testServer, convID, agentID string) (int64, bool) {
	var ms int64
	err := ts.pool.QueryRow(context.Background(),
		`SELECT (extract(epoch FROM last_delivered_at) * 1000)::bigint
		 FROM conversation_participants WHERE conversation_id = $1 AND agent_id = $2`,
		convID, agentID).Scan(&ms)
	return ms, err == nil
}

func redisCursorRaw(t *testing.T, ts *testServer, agentID, convID string) (string, bool) {
	t.Helper()
	raw, err := ts.rdb.Get(context.Background(), verse.AckCursorKey(agentID, convID)).Result()
	if err != nil {
		return "", false
	}
	return raw, true
}

func sendAck(t *testing.T, c *testClient, payload map[string]any) {
	t.Helper()
	c.send(t, verse.NewEnvelope(verse.EventAck, payload))
}

// ackSetup seeds a conversation, a participant (agent) with its cursor
// at base, and one message from a peer at base+10s.
func ackSetup(t *testing.T, ts *testServer) (agentID, peerID, convID, msgID string, base time.Time) {
	t.Helper()
	owner := seedOwner(t, ts.pool)
	agentID = seedAgent(t, ts.pool, &owner, "AckCursorAgent", "offline", nil)
	peerID = seedAgent(t, ts.pool, &owner, "AckCursorPeer", "offline", nil)
	convID = seedConversation(t, ts.pool)
	base = time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, agentID, base, base)
	msgID = seedMessage(t, ts.pool, convID, peerID, "ack me", base.Add(10*time.Second))
	return agentID, peerID, convID, msgID, base
}

func msgTs(base time.Time) int64 { return base.Add(10 * time.Second).UnixMilli() }

func TestAckDualModeWritesPGAndRedis(t *testing.T) {
	t.Setenv("AIVERSE_ACK_CURSOR_MODE", "dual")
	ts := startTestServer(t)
	ctx := context.Background()
	agentID, _, convID, msgID, base := ackSetup(t, ts)
	c := connectAgent(t, ts, agentID)

	sendAck(t, c, map[string]any{"conversationId": convID, "messageId": msgID})

	// TS (a): the ack writes PG and advances the Redis cursor to the
	// same value; the dirty set gains the member for the checkpoint.
	want := msgTs(base)
	waitFor(t, "dual ack lands in PG + Redis", 3*time.Second, func() bool {
		got, ok := pgCursorMsOK(ts, convID, agentID); return ok && got == want
	})
	raw, ok := redisCursorRaw(t, ts, agentID, convID)
	if !ok || raw != fmt.Sprintf("%d:%s", want, msgID) {
		t.Fatalf("redis cursor = %q (ok=%v), want %q", raw, ok, fmt.Sprintf("%d:%s", want, msgID))
	}
	isMember, err := ts.rdb.SIsMember(ctx, verse.AckCursorDirtySet, agentID+":"+convID).Result()
	if err != nil || !isMember {
		t.Fatalf("dirty set membership = %v (err=%v), want true", isMember, err)
	}
	c.ws.CloseNow()
}

func TestAckRedisModeSkipsPGAndBacklogReadsMax(t *testing.T) {
	t.Setenv("AIVERSE_ACK_CURSOR_MODE", "redis")
	ts := startTestServer(t)
	agentID, peerID, convID, msgID, base := ackSetup(t, ts)
	// A second, never-acked message after the acked one.
	peer2Msg := seedMessage(t, ts.pool, convID, peerID, "not acked", base.Add(20*time.Second))

	c := connectAgent(t, ts, agentID)
	// Drain the connect backlog (both messages replay — nothing acked
	// yet), then ack only the first.
	c.collectFrames(500 * time.Millisecond)
	sendAck(t, c, map[string]any{"conversationId": convID, "messageId": msgID})

	// TS (b): zero PG writes — the durable cursor never moves; the
	// Redis cursor carries the ack on its own.
	want := msgTs(base)
	waitFor(t, "redis cursor advances in redis mode", 3*time.Second, func() bool {
		_, ok := redisCursorRaw(t, ts, agentID, convID)
		return ok
	})
	if got := pgCursorMs(t, ts, convID, agentID); got != base.UnixMilli() {
		t.Fatalf("PG cursor = %d in redis mode, want unchanged %d", got, base.UnixMilli())
	}
	raw, _ := redisCursorRaw(t, ts, agentID, convID)
	if raw != fmt.Sprintf("%d:%s", want, msgID) {
		t.Fatalf("redis cursor = %q, want %q", raw, fmt.Sprintf("%d:%s", want, msgID))
	}
	c.ws.CloseNow()

	// Every reader takes max(PG, Redis): the reconnect backlog must
	// NOT replay the acked message (PG alone would), and MUST replay
	// the unacked one.
	c2 := connectAgent(t, ts, agentID)
	frames := c2.collectFrames(700 * time.Millisecond)
	var replayed []string
	for _, raw := range frames {
		if frameType(t, raw) == verse.EventMessage {
			replayed = append(replayed, framePayload(t, raw)["message_id"].(string))
		}
	}
	if len(replayed) != 1 || replayed[0] != peer2Msg {
		t.Fatalf("reconnect replay = %v, want exactly the unacked message %s", replayed, peer2Msg)
	}
	c2.ws.CloseNow()
}

func TestAckLegacyModePGOnly(t *testing.T) {
	t.Setenv("AIVERSE_ACK_CURSOR_MODE", "legacy")
	ts := startTestServer(t)
	ctx := context.Background()
	agentID, _, convID, msgID, base := ackSetup(t, ts)
	c := connectAgent(t, ts, agentID)

	sendAck(t, c, map[string]any{"conversationId": convID, "messageId": msgID})

	// TS (f): the rollback path — PG advances, no Redis cursor, no
	// dirty member.
	want := msgTs(base)
	waitFor(t, "legacy ack lands in PG", 3*time.Second, func() bool {
		got, ok := pgCursorMsOK(ts, convID, agentID); return ok && got == want
	})
	time.Sleep(200 * time.Millisecond) // let any (wrong) Redis write land
	if _, ok := redisCursorRaw(t, ts, agentID, convID); ok {
		t.Fatal("legacy mode wrote a Redis ack cursor")
	}
	if isMember, _ := ts.rdb.SIsMember(ctx, verse.AckCursorDirtySet, agentID+":"+convID).Result(); isMember {
		t.Fatal("legacy mode marked the cursor dirty")
	}
	c.ws.CloseNow()
}

func TestAckCursorMonotonic(t *testing.T) {
	t.Setenv("AIVERSE_ACK_CURSOR_MODE", "dual")
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "AckMonoAgent", "offline", nil)
	peer := seedAgent(t, ts.pool, &owner, "AckMonoPeer", "offline", nil)
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, agentID, base, base)
	older := seedMessage(t, ts.pool, convID, peer, "older", base.Add(10*time.Second))
	newer := seedMessage(t, ts.pool, convID, peer, "newer", base.Add(20*time.Second))

	c := connectAgent(t, ts, agentID)
	c.collectFrames(400 * time.Millisecond)
	// Ack the newer first, then the older: neither store may move
	// backward (the Lua advance and the PG lt guard are the same rule).
	sendAck(t, c, map[string]any{"conversationId": convID, "messageId": newer})
	waitFor(t, "cursor at newer", 3*time.Second, func() bool {
		raw, ok := redisCursorRaw(t, ts, agentID, convID)
		return ok && raw == fmt.Sprintf("%d:%s", base.Add(20*time.Second).UnixMilli(), newer)
	})
	sendAck(t, c, map[string]any{"conversationId": convID, "messageId": older})
	time.Sleep(400 * time.Millisecond)
	raw, _ := redisCursorRaw(t, ts, agentID, convID)
	if want := fmt.Sprintf("%d:%s", base.Add(20*time.Second).UnixMilli(), newer); raw != want {
		t.Fatalf("redis cursor after out-of-order ack = %q, want %q", raw, want)
	}
	if got := pgCursorMs(t, ts, convID, agentID); got != base.Add(20*time.Second).UnixMilli() {
		t.Fatalf("PG cursor after out-of-order ack = %d, want %d", got, base.Add(20*time.Second).UnixMilli())
	}
	c.ws.CloseNow()
}

func TestMentionAckModes(t *testing.T) {
	// Redis mode: no PG ackedAt — the checkpoint set is the only
	// record until the leader's checkpoint lands.
	t.Run("redis", func(t *testing.T) {
		t.Setenv("AIVERSE_ACK_CURSOR_MODE", "redis")
		ts := startTestServer(t)
		ctx := context.Background()
		owner := seedOwner(t, ts.pool)
		agentID := seedAgent(t, ts.pool, &owner, "MentionRedisAgent", "offline", nil)
		by := seedAgent(t, ts.pool, &owner, "MentionRedisBy", "offline", nil)
		convID := seedConversation(t, ts.pool)
		base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		msgID := seedMessage(t, ts.pool, convID, by, "hi @you", base)
		mentionID := seedMention(t, ts.pool, agentID, by, "MentionRedisBy", convID, msgID, "hi @you", base)

		c := connectAgent(t, ts, agentID)
		c.collectFrames(400 * time.Millisecond)
		sendAck(t, c, map[string]any{"mentionId": mentionID})

		waitFor(t, "mention ack joins the checkpoint set", 3*time.Second, func() bool {
			isMember, _ := ts.rdb.SIsMember(ctx, verse.MentionAckKey(agentID), mentionID).Result()
			return isMember
		})
		if isMember, _ := ts.rdb.SIsMember(ctx, verse.MentionAckDirtyAgents, agentID).Result(); !isMember {
			t.Fatal("agent not in the mention dirty-agents set")
		}
		var acked *time.Time
		if err := ts.pool.QueryRow(ctx, `SELECT acked_at FROM mentions WHERE id = $1`, mentionID).Scan(&acked); err != nil {
			t.Fatal(err)
		}
		if acked != nil {
			t.Fatalf("redis mode set ackedAt = %v, want NULL (checkpoint owns it)", acked)
		}
		c.ws.CloseNow()
	})

	// Early mention ack (row not yet persisted): stashed AND in the
	// checkpoint set, so the ack lands when the row appears (TS (e)'s
	// persist-window half).
	t.Run("early", func(t *testing.T) {
		t.Setenv("AIVERSE_ACK_CURSOR_MODE", "dual")
		ts := startTestServer(t)
		ctx := context.Background()
		owner := seedOwner(t, ts.pool)
		agentID := seedAgent(t, ts.pool, &owner, "MentionEarlyAgent", "offline", nil)
		c := connectAgent(t, ts, agentID)

		mentionID := uuid.NewString()
		sendAck(t, c, map[string]any{"mentionId": mentionID})
		waitFor(t, "early mention ack stashed + checkpointed", 3*time.Second, func() bool {
			e, _ := ts.rdb.Exists(ctx, verse.EarlyAckMentionKey(mentionID)).Result()
			isMember, _ := ts.rdb.SIsMember(ctx, verse.MentionAckKey(agentID), mentionID).Result()
			return e == 1 && isMember
		})
		c.ws.CloseNow()
	})
}

func TestAckResolvesFromIngestStreamTail(t *testing.T) {
	t.Setenv("AIVERSE_ACK_CURSOR_MODE", "dual")
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "AckStreamAgent", "offline", nil)
	peer := seedAgent(t, ts.pool, &owner, "AckStreamPeer", "offline", nil)
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	seedParticipant(t, ts.pool, convID, agentID, base, base)

	// The message exists ONLY as a pending ingest entry (the consumer
	// hasn't persisted it): the ack must still resolve its ts from the
	// stream tail — the persist-window case resolveAckMessageCreatedAt
	// exists for — instead of dropping to the early-ack stash.
	msgID := uuid.NewString()
	msgAt := base.Add(30 * time.Second)
	xaddIngest(t, ts, map[string]any{
		"id": msgID, "conversationId": convID, "senderAgentId": peer,
		"content": "unpersisted", "ts": fmt.Sprint(msgAt.UnixMilli()),
	})

	c := connectAgent(t, ts, agentID)
	c.collectFrames(400 * time.Millisecond)
	sendAck(t, c, map[string]any{"conversationId": convID, "messageId": msgID})

	waitFor(t, "stream-resolved ack advances both cursors", 3*time.Second, func() bool {
		raw, ok := redisCursorRaw(t, ts, agentID, convID)
		got, pgOK := pgCursorMsOK(ts, convID, agentID)
		return ok && raw == fmt.Sprintf("%d:%s", msgAt.UnixMilli(), msgID) &&
			pgOK && got == msgAt.UnixMilli()
	})
	if exists, _ := ts.rdb.Exists(context.Background(), verse.EarlyAckMsgKey(convID, agentID, msgID)).Result(); exists != 0 {
		t.Fatal("resolved ack was ALSO stashed as an early ack — resolution failed")
	}
	c.ws.CloseNow()
}
