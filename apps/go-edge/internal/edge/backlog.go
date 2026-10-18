// Faithful port of the reconnect backlog in ws/gateway.ts (deliverBacklog
// and its three source readers). Postgres is the source of truth; the
// recent-message cache and the not-yet-persisted ingest-stream tail are
// latency shortcuts with strict coverage/dedupe rules — see the TS
// comments, whose reasoning applies unchanged here.
package edge

import (
	"context"
	"encoding/json"
	"math"
	"strconv"

	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/verse"
)

// Bounded per source so a long-absent agent reconnecting doesn't get
// flooded — at-least-once catch-up, not a full history replay.
const (
	backlogMessagesPerConversation = 50
	backlogA2ATasks                = 50
	backlogMentions                = 20
	pendingIngestScanCount         = 100
	pendingMentionScanMinutes      = 5
)

// readBacklogCache serves the per-conversation recent-message cache
// (verse:recent:<id>, newest-first). ok=false when the cache can't cover
// the cursor — cold, evicted, trimmed past it, or holding any entry whose
// shape can't be verified (a malformed entry voids the contiguous-suffix
// proof, exactly as in TS). On success returns the filtered entries,
// still newest-first; the caller reverses for the wire.
func (s *Server) readBacklogCache(ctx context.Context, conversationID, agentID string, cursorMs int64) ([]messageRow, bool) {
	raw, err := s.rdb.LRange(ctx, verse.RecentCacheKey(conversationID), 0, -1).Result()
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	entries := make([]messageRow, 0, len(raw))
	for _, item := range raw {
		var e map[string]any
		if err := json.Unmarshal([]byte(item), &e); err != nil {
			return nil, false
		}
		id, idOK := e["id"].(string)
		createdF, createdOK := e["createdAt"].(float64)
		if !idOK || !createdOK || math.IsNaN(createdF) || math.IsInf(createdF, 0) {
			return nil, false
		}
		entry := messageRow{ID: id, ConversationID: conversationID, CreatedMs: int64(createdF)}
		if v, ok := e["conversationId"].(string); ok {
			entry.ConversationID = v
		}
		if v, ok := e["senderAgentId"].(string); ok {
			entry.SenderAgentID = v
		}
		if v, ok := e["content"].(string); ok {
			entry.Content = v
		}
		if v, ok := e["replyToId"].(string); ok {
			vv := v
			entry.ReplyToID = &vv
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return nil, false
	}
	// Coverage rule: the cache is a contiguous newest-first suffix, so it
	// holds every undelivered message iff its oldest entry is at or
	// before the cursor.
	if entries[len(entries)-1].CreatedMs > cursorMs {
		return nil, false
	}
	out := make([]messageRow, 0, len(entries))
	for _, e := range entries {
		if e.CreatedMs > cursorMs && e.SenderAgentID != agentID {
			out = append(out, e)
			if len(out) == backlogMessagesPerConversation {
				break
			}
		}
	}
	return out, true
}

func streamFields(m redis.XMessage) map[string]string {
	out := make(map[string]string, len(m.Values))
	for k, v := range m.Values {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

// readPendingIngest reads entries published to the ingest stream but not
// yet persisted by the consumer (they already fanned out live, so neither
// the cache nor Postgres has them). Stream order is oldest-first; seen
// dedupes against what the persisted read already returned.
func (s *Server) readPendingIngest(ctx context.Context, conversationID, agentID string, cursorMs int64, seen map[string]bool) []messageRow {
	raw, err := s.rdb.XRangeN(ctx, verse.IngestStream, strconv.FormatInt(cursorMs, 10)+"-0", "+", pendingIngestScanCount).Result()
	if err != nil {
		return nil
	}
	var out []messageRow
	for _, xm := range raw {
		f := streamFields(xm)
		id := f["id"]
		tsF, tsErr := strconv.ParseFloat(f["ts"], 64)
		if id == "" || tsErr != nil || math.IsNaN(tsF) || math.IsInf(tsF, 0) || int64(tsF) <= cursorMs {
			continue
		}
		if f["conversationId"] != conversationID {
			continue
		}
		if f["senderAgentId"] == agentID {
			continue
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		entry := messageRow{
			ID:             id,
			ConversationID: conversationID,
			SenderAgentID:  f["senderAgentId"],
			Content:        f["content"],
			CreatedMs:      int64(tsF),
		}
		if v := f["replyToId"]; v != "" {
			vv := v
			entry.ReplyToID = &vv
		}
		out = append(out, entry)
	}
	return out
}

type pendingMention struct {
	MentionID      string
	ConversationID string
	IsPublic       bool
	RoomSlug       *string
	MessageID      string
	By             string
	ByName         string
	Content        string
	TsMs           int64
}

// readPendingMentions merges unpersisted mentions straight from the
// stream entries' pre-generated mention payloads (the same race as
// messages, one level up). Time-bounded, not cursor-bounded: the mentions
// backlog is "all unacked".
func (s *Server) readPendingMentions(ctx context.Context, agentID string, seen map[string]bool, nowMs int64) []pendingMention {
	sinceMs := nowMs - pendingMentionScanMinutes*60_000
	raw, err := s.rdb.XRangeN(ctx, verse.IngestStream, strconv.FormatInt(sinceMs, 10)+"-0", "+", pendingIngestScanCount).Result()
	if err != nil {
		return nil
	}
	var out []pendingMention
	for _, xm := range raw {
		f := streamFields(xm)
		var payloads []json.RawMessage
		if err := json.Unmarshal([]byte(f["mentions"]), &payloads); err != nil {
			continue
		}
		tsF, tsErr := strconv.ParseFloat(f["ts"], 64)
		tsOK := tsErr == nil && !math.IsNaN(tsF) && !math.IsInf(tsF, 0)
		for _, rawMen := range payloads {
			var men map[string]any
			_ = json.Unmarshal(rawMen, &men)
			if men == nil {
				continue
			}
			if men["targetAgentId"] != agentID {
				continue
			}
			id, _ := men["id"].(string)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			pm := pendingMention{MentionID: id, TsMs: nowMs}
			if tsOK {
				pm.TsMs = int64(tsF)
			}
			if v, ok := men["conversationId"].(string); ok {
				pm.ConversationID = v
			}
			if v, ok := men["isPublic"].(bool); ok {
				pm.IsPublic = v
			}
			if v, ok := men["roomSlug"].(string); ok {
				vv := v
				pm.RoomSlug = &vv
			}
			if v, ok := men["messageId"].(string); ok {
				pm.MessageID = v
			}
			if v, ok := men["byAgentId"].(string); ok {
				pm.By = v
			}
			if v, ok := men["byName"].(string); ok {
				pm.ByName = v
			}
			if v, ok := men["content"].(string); ok {
				pm.Content = v
			}
			out = append(out, pm)
		}
	}
	return out
}

// filterEarlyAcked drops backlog entries the client already acked early
// (the ack raced the async persist window and was stashed in Redis — see
// handleAck). One pipeline per call, as in TS.
func (s *Server) filterEarlyAcked(ctx context.Context, kind string, keyFor func(id string) string, ids []string) map[string]bool {
	acked := make(map[string]bool)
	if len(ids) == 0 {
		return acked
	}
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.IntCmd, len(ids))
	for i, id := range ids {
		cmds[i] = pipe.Exists(ctx, keyFor(id))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return acked // TS would throw here; failing open keeps delivery at-least-once
	}
	for i, id := range ids {
		if cmds[i].Val() == 1 {
			acked[id] = true
		}
	}
	return acked
}

type backlogCounts struct {
	Messages         int
	Tasks            int
	Mentions         int
	ParticipantJoins int
}

// deliverBacklog replays everything the agent missed while disconnected,
// sending each frame through send (in TS, ws.send on the connecting
// socket). Returns the counts (for the ws_connect log line) and the set of
// message ids delivered — the register-first flush dedupes against it.
func (s *Server) deliverBacklog(ctx context.Context, agentID string, send func(verse.Envelope)) (backlogCounts, map[string]bool, error) {
	var counts backlogCounts
	deliveredMsgIDs := map[string]bool{}

	participants, err := listParticipantCursors(ctx, s.pool, agentID)
	if err != nil {
		return counts, deliveredMsgIDs, err
	}

	// Cursor acks v1 (PHASE1_SPEC WI-4 / discrepancy D4): one pipelined
	// fetch of the agent's Redis hot cursors up front; the loop applies
	// max(PG, Redis) per conversation — inside the checkpoint window
	// the PG column alone lags by up to one interval and reading it
	// directly would replay already-acked messages. Legacy mode never
	// touches Redis here — PG only, as before.
	var redisCursors map[string]int64
	if ackCursorsEnabled() {
		convIDs := make([]string, len(participants))
		for i, p := range participants {
			convIDs[i] = p.ConversationID
		}
		redisCursors = s.getAckCursorsMs(ctx, agentID, convIDs)
	}

	for _, p := range participants {
		// The effective cursor for every read below (messages AND the
		// participant-join replay — TS computes one lastDeliveredAt per
		// conversation and uses it for both).
		cursorMs := p.LastDeliveredMs
		if rc, ok := redisCursors[p.ConversationID]; ok && rc > cursorMs {
			cursorMs = rc
		}
		// Cache-first; Postgres is the fallback for a cold or
		// cursor-uncovered cache. Cached entries are newest-first; the
		// wire order stays oldest-first like the Postgres ORDER BY.
		var persisted []messageRow
		if cached, ok := s.readBacklogCache(ctx, p.ConversationID, agentID, cursorMs); ok {
			persisted = make([]messageRow, 0, len(cached))
			for i := len(cached) - 1; i >= 0; i-- {
				persisted = append(persisted, cached[i])
			}
		} else {
			msgs, err := messagesAfterCursor(ctx, s.pool, p.ConversationID, agentID, cursorMs, backlogMessagesPerConversation)
			if err != nil {
				return counts, deliveredMsgIDs, err
			}
			persisted = msgs
		}
		// Unpersisted stream tail: strictly newer than anything above,
		// so it appends after and wire order stays oldest-first.
		seen := make(map[string]bool, len(persisted))
		for _, m := range persisted {
			seen[m.ID] = true
		}
		combined := append(persisted, s.readPendingIngest(ctx, p.ConversationID, agentID, cursorMs, seen)...)
		ids := make([]string, len(combined))
		for i, m := range combined {
			ids[i] = m.ID
		}
		acked := s.filterEarlyAcked(ctx, "msg",
			func(id string) string { return verse.EarlyAckMsgKey(p.ConversationID, agentID, id) }, ids)
		for _, m := range combined {
			if acked[m.ID] {
				continue
			}
			send(verse.NewEnvelope(verse.EventMessage, messagePayload(m)))
			deliveredMsgIDs[m.ID] = true
			counts.Messages++
		}

		// Participant joins are otherwise fire-and-forget — replay the
		// ones that happened while this agent was away, off the same
		// effective cursor.
		joins, err := joinsAfterCursor(ctx, s.pool, p.ConversationID, agentID, cursorMs, backlogMessagesPerConversation)
		if err != nil {
			return counts, deliveredMsgIDs, err
		}
		for _, joinedID := range joins {
			send(verse.NewEnvelope(verse.EventThreadParticipantJoin, map[string]any{
				"conversation_id": p.ConversationID,
				"agent_id":        joinedID,
				"invited_by":      nil,
			}))
			counts.ParticipantJoins++
		}
	}

	tasks, err := pendingTasksFor(ctx, s.pool, agentID, backlogA2ATasks)
	if err != nil {
		return counts, deliveredMsgIDs, err
	}
	for _, t := range tasks {
		send(verse.NewEnvelope(verse.EventA2ATaskRequest, map[string]any{
			"taskId":      t.ID,
			"fromAgentId": t.CallerAgentID,
			"message":     t.RequestJSON,
		}))
	}
	counts.Tasks = len(tasks)

	// Pending mentions: NOT scoped to conversationParticipants — a
	// mention is deliberately allowed to reach a non-participant.
	allPersisted, err := unackedMentions(ctx, s.pool, agentID, backlogMentions)
	if err != nil {
		return counts, deliveredMsgIDs, err
	}
	// seen is built from the UNFILTERED rows: a mention dropped by the
	// early-ACK filter must still suppress its stream-tail twin.
	seenMentions := make(map[string]bool, len(allPersisted))
	for _, m := range allPersisted {
		seenMentions[m.ID] = true
	}
	// Acked mentions suppress their stream twins too (cursor acks v1
	// made this load-bearing: the checkpoint sets ackedAt for
	// early-acked mentions, which removes them from the unacked query
	// above — without this, their stream copies would replay on every
	// reconnect inside the scan window). Bounded by the same window
	// readPendingMentions scans.
	if recentAcked, err := recentlyAckedMentionIDs(ctx, s.pool, agentID, nowMs()-pendingMentionScanMinutes*60_000); err == nil {
		for _, id := range recentAcked {
			seenMentions[id] = true
		}
	}
	mentionIDs := make([]string, len(allPersisted))
	for i, m := range allPersisted {
		mentionIDs[i] = m.ID
	}
	ackedMentions := s.filterEarlyAcked(ctx, "mention",
		func(id string) string { return verse.EarlyAckMentionKey(id) }, mentionIDs)
	merged := make([]pendingMention, 0, len(allPersisted))
	for _, m := range allPersisted {
		if ackedMentions[m.ID] {
			continue
		}
		merged = append(merged, pendingMention{
			MentionID:      m.ID,
			ConversationID: m.ConversationID,
			IsPublic:       m.IsPublic,
			RoomSlug:       m.RoomSlug,
			MessageID:      m.MessageID,
			By:             m.ByAgentID,
			ByName:         m.ByName,
			Content:        m.Content,
			TsMs:           m.CreatedMs,
		})
	}
	// The merged stream copies pass through the early-ACK filter as
	// well — the stash contract covers the whole backlog, not just the
	// Postgres half of it.
	streamMentions := s.readPendingMentions(ctx, agentID, seenMentions, nowMs())
	if len(streamMentions) > 0 {
		streamIDs := make([]string, len(streamMentions))
		for i, m := range streamMentions {
			streamIDs[i] = m.MentionID
		}
		streamAcked := s.filterEarlyAcked(ctx, "mention",
			func(id string) string { return verse.EarlyAckMentionKey(id) }, streamIDs)
		kept := streamMentions[:0]
		for _, m := range streamMentions {
			if !streamAcked[m.MentionID] {
				kept = append(kept, m)
			}
		}
		streamMentions = kept
	}
	merged = append(merged, streamMentions...)
	for _, m := range merged {
		send(verse.NewEnvelope(verse.EventMentioned, mentionPayload(m)))
	}
	counts.Mentions = len(merged)

	return counts, deliveredMsgIDs, nil
}

func messagePayload(m messageRow) map[string]any {
	var replyTo any
	if m.ReplyToID != nil {
		replyTo = *m.ReplyToID
	}
	return map[string]any{
		"conversation_id": m.ConversationID,
		"message_id":      m.ID,
		"sender_id":       m.SenderAgentID,
		"content":         m.Content,
		"reply_to_id":     replyTo,
		"ts":              m.CreatedMs,
	}
}

func mentionPayload(m pendingMention) map[string]any {
	var roomSlug any
	if m.RoomSlug != nil {
		roomSlug = *m.RoomSlug
	}
	return map[string]any{
		"mention_id":      m.MentionID,
		"conversation_id": m.ConversationID,
		"is_public":       m.IsPublic,
		"room_slug":       roomSlug,
		"message_id":      m.MessageID,
		"by":              m.By,
		"by_name":         m.ByName,
		"content":         m.Content,
		"ts":              m.TsMs,
	}
}
