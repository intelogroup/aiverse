package edge

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"aiverse/go-edge/internal/verse"
)

// WI-2 (PHASE1_SPEC): a participant whose conversation_participants.mode
// is 'passive' receives mentions and control frames over a live socket
// but NOT message frames; the suppressed messages replay from the
// backlog instead (the backlog itself does not skip passive
// participants — WI-2 is live-delivery semantics only). Mirrors the TS
// subscription.test.ts case trio: (a) HTTP-created passive join,
// (b) WS deliveries skip passive for MESSAGE only, (c) the backlog
// still delivers to a passive participant.

func setParticipantMode(t *testing.T, ts *testServer, convID, agentID, mode string) {
	t.Helper()
	_, err := ts.pool.Exec(context.Background(),
		`UPDATE conversation_participants SET mode = $3
		 WHERE conversation_id = $1 AND agent_id = $2`, convID, agentID, mode)
	if err != nil {
		t.Fatalf("set participant mode: %v", err)
	}
}

func envelopeBytes(t *testing.T, eventType string, payload map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(verse.NewEnvelope(eventType, payload))
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return raw
}

func TestPassiveFanoutDelivery(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "PassiveSender", "offline", nil)
	passive := seedAgent(t, ts.pool, &owner, "PassiveAgent", "offline", nil)
	active := seedAgent(t, ts.pool, &owner, "ActiveAgent", "offline", nil)
	convID := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	for _, a := range []string{sender, passive, active} {
		seedParticipant(t, ts.pool, convID, a, base, base)
	}
	setParticipantMode(t, ts, convID, passive, "passive")

	// (c) A message older than the connect replays to the passive
	// participant from the backlog — backlog delivery is NOT
	// mode-filtered in TS, and neither is it here.
	backlogMsg := seedMessage(t, ts.pool, convID, sender, "from backlog", base.Add(time.Minute))

	pc := connectAgent(t, ts, passive)
	ac := connectAgent(t, ts, active)
	pDrain := pc.collectFrames(700 * time.Millisecond)
	ac.collectFrames(700 * time.Millisecond)
	sawBacklog := false
	for _, raw := range pDrain {
		if frameType(t, raw) == verse.EventMessage &&
			framePayload(t, raw)["message_id"] == backlogMsg {
			sawBacklog = true
		}
	}
	if !sawBacklog {
		t.Fatal("passive participant did not receive the backlog message (WI-2 must not filter backlog)")
	}

	// (b) Live fanout: message / mentioned / thread_participant_joined
	// to the passive socket, and the same message to the active socket
	// as the positive control.
	liveMsgID := uuid.NewString()
	msgFrame := envelopeBytes(t, verse.EventMessage, map[string]any{
		"conversation_id": convID,
		"message_id":      liveMsgID,
		"sender_id":       sender,
		"content":         "live",
		"reply_to_id":     nil,
		"ts":              time.Now().UnixMilli(),
	})
	mentionFrame := envelopeBytes(t, verse.EventMentioned, map[string]any{
		"mention_id":            uuid.NewString(),
		"conversation_id":       convID,
		"message_id":            liveMsgID,
		"mentioned_by_agent_id": sender,
		"content":               "live @you",
		"ts":                    time.Now().UnixMilli(),
	})
	joinedFrame := envelopeBytes(t, verse.EventThreadParticipantJoin, map[string]any{
		"conversation_id": convID,
		"agent_id":        sender,
		"agent_name":      "PassiveSender",
		"ts":              time.Now().UnixMilli(),
	})
	publish := func(agentID string, event []byte) {
		ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "agent", AgentID: agentID, Event: event})
	}
	publish(passive, msgFrame)
	publish(passive, mentionFrame)
	publish(passive, joinedFrame)
	publish(active, msgFrame)

	// The mention and joined frames arriving on the passive socket
	// prove its earlier message frame was processed (same channel,
	// same order) — and suppressed.
	pFrames := pc.collectFrames(1200 * time.Millisecond)
	var sawMention, sawJoined bool
	for _, raw := range pFrames {
		switch frameType(t, raw) {
		case verse.EventMessage:
			t.Fatalf("passive participant received a live MESSAGE frame: %s", raw)
		case verse.EventMentioned:
			sawMention = true
		case verse.EventThreadParticipantJoin:
			sawJoined = true
		}
	}
	if !sawMention {
		t.Fatal("passive participant did not receive the mention frame (mentions must deliver)")
	}
	if !sawJoined {
		t.Fatal("passive participant did not receive thread_participant_joined (control frames must deliver)")
	}

	aFrames := ac.collectFrames(300 * time.Millisecond)
	sawLive := false
	for _, raw := range aFrames {
		if frameType(t, raw) == verse.EventMessage &&
			framePayload(t, raw)["message_id"] == liveMsgID {
			sawLive = true
		}
	}
	if !sawLive {
		t.Fatal("active participant did not receive the live message (positive control)")
	}
	pc.ws.CloseNow()
	ac.ws.CloseNow()
}

// Suppression is conversation-scoped and mode-exact: the same agent in
// 'active' mode in another conversation still receives its messages,
// and a participant row that does not exist (no-row) delivers.
func TestPassiveSuppressionScoped(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sender := seedAgent(t, ts.pool, &owner, "ScopedSender", "offline", nil)
	agent := seedAgent(t, ts.pool, &owner, "ScopedAgent", "offline", nil)
	passiveConv := seedConversation(t, ts.pool)
	activeConv := seedConversation(t, ts.pool)
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	for _, conv := range []string{passiveConv, activeConv} {
		seedParticipant(t, ts.pool, conv, sender, base, base)
		seedParticipant(t, ts.pool, conv, agent, base, base)
	}
	setParticipantMode(t, ts, passiveConv, agent, "passive")

	c := connectAgent(t, ts, agent)
	c.collectFrames(600 * time.Millisecond)

	publish := func(convID, msgID string) {
		frame := envelopeBytes(t, verse.EventMessage, map[string]any{
			"conversation_id": convID, "message_id": msgID,
			"sender_id": sender, "content": "x", "reply_to_id": nil,
			"ts": time.Now().UnixMilli(),
		})
		ts.srv.PublishFanout(ctx, verse.FanoutMessage{Kind: "agent", AgentID: agent, Event: frame})
	}
	suppressedID := uuid.NewString()
	deliveredID := uuid.NewString()
	noRowID := uuid.NewString()
	publish(passiveConv, suppressedID)
	publish(activeConv, deliveredID)
	publish(uuid.NewString(), noRowID) // not a participant anywhere

	frames := c.collectFrames(1200 * time.Millisecond)
	var got []string
	for _, raw := range frames {
		if frameType(t, raw) == verse.EventMessage {
			got = append(got, framePayload(t, raw)["message_id"].(string))
		}
	}
	for _, id := range got {
		if id == suppressedID {
			t.Fatalf("message for the passive conversation was delivered: %v", got)
		}
	}
	var sawDelivered, sawNoRow bool
	for _, id := range got {
		if id == deliveredID {
			sawDelivered = true
		}
		if id == noRowID {
			sawNoRow = true
		}
	}
	if !sawDelivered {
		t.Fatalf("message for the active conversation missing: %v", got)
	}
	if !sawNoRow {
		t.Fatalf("message with no participant row missing (fail-open): %v", got)
	}
	c.ws.CloseNow()
}
