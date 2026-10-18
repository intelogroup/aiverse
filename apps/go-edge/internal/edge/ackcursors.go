// Cursor acks v1 (ws/ackCursors.ts, PHASE1_SPEC WI-4): an ack no
// longer pays a per-message Postgres UPDATE. It advances a Redis-held
// cursor per (agent, conversation); a leader-only checkpoint job (TS
// side — not this edge's job) flushes dirty cursors to Postgres.
// Readers take max(PG, Redis) so nothing regresses inside the
// checkpoint window.
//
// Rollout follows AIVERSE_ACK_CURSOR_MODE:
//   legacy — PG write per ack, no Redis cursors (the rollback path)
//   dual   — PG write AND Redis advance (the default)
//   redis  — Redis advance only; PG moves at checkpoint
//
// This file ports the edge-side halves of ackCursors.ts: the mode, the
// atomic monotonic advance, the cursor reads, and the mention-ack sets.
// The checkpoint writer itself stays with the TS leader's singleton
// jobs, exactly as it does when a TS edge serves the socket.
package edge

import (
	"context"
	"os"
	"strconv"
	"strings"

	"aiverse/go-edge/internal/verse"
)

type ackCursorModeT string

const (
	ackModeLegacy ackCursorModeT = "legacy"
	ackModeDual   ackCursorModeT = "dual"
	ackModeRedis  ackCursorModeT = "redis"
)

// ackCursorMode reads the env per call, like the TS ackCursorMode() —
// a mode flip needs no restart on either implementation.
func ackCursorMode() ackCursorModeT {
	switch os.Getenv("AIVERSE_ACK_CURSOR_MODE") {
	case "legacy":
		return ackModeLegacy
	case "redis":
		return ackModeRedis
	default:
		return ackModeDual
	}
}

func ackCursorsEnabled() bool { return ackCursorMode() != ackModeLegacy }

// parseAckCursorValue parses the "{tsMs}:{messageId}" cursor value.
func parseAckCursorValue(raw string) (int64, bool) {
	sep := strings.Index(raw, ":")
	if sep < 0 {
		return 0, false
	}
	tsMs, err := strconv.ParseInt(raw[:sep], 10, 64)
	if err != nil {
		return 0, false
	}
	return tsMs, true
}

// advanceAckCursorLua is the TS ADVANCE_CURSOR_LUA verbatim: monotonic
// advance, atomic — a non-atomic read-modify-write could let a slow
// older ack overwrite a newer cursor under concurrency. Marks the key
// dirty only when the cursor actually moved. Returns 1 when this ack
// advanced the cursor.
const advanceAckCursorLua = `
local cur = redis.call('GET', KEYS[1])
local curTs = -1
if cur then
  local s = string.match(cur, '^(%d+):')
  if s then curTs = tonumber(s) end
end
if tonumber(ARGV[1]) > curTs then
  redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2])
  redis.call('SADD', KEYS[2], ARGV[3])
  return 1
end
return 0
`

func (s *Server) advanceAckCursor(ctx context.Context, agentID, conversationID string, tsMs int64, messageID string) (bool, error) {
	res, err := s.rdb.Eval(ctx, advanceAckCursorLua,
		[]string{verse.AckCursorKey(agentID, conversationID), verse.AckCursorDirtySet},
		strconv.FormatInt(tsMs, 10), messageID, agentID+":"+conversationID,
	).Int64()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

func (s *Server) getAckCursorMs(ctx context.Context, agentID, conversationID string) (int64, bool) {
	raw, err := s.rdb.Get(ctx, verse.AckCursorKey(agentID, conversationID)).Result()
	if err != nil {
		return 0, false
	}
	return parseAckCursorValue(raw)
}

// getAckCursorsMs is one pipelined MGET over the agent's conversations
// — the backlog reader's per-agent fetch.
func (s *Server) getAckCursorsMs(ctx context.Context, agentID string, conversationIDs []string) map[string]int64 {
	out := make(map[string]int64)
	if len(conversationIDs) == 0 {
		return out
	}
	keys := make([]string, len(conversationIDs))
	for i, id := range conversationIDs {
		keys[i] = verse.AckCursorKey(agentID, id)
	}
	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return out
	}
	for i, v := range vals {
		if str, ok := v.(string); ok {
			if tsMs, ok := parseAckCursorValue(str); ok {
				out[conversationIDs[i]] = tsMs
			}
		}
	}
	return out
}

// addMentionAck records a mention ack in the agent's pending set —
// mention acks have no cursor; the checkpoint batch-marks ackedAt.
func (s *Server) addMentionAck(ctx context.Context, agentID, mentionID string) {
	pipe := s.rdb.Pipeline()
	pipe.SAdd(ctx, verse.MentionAckKey(agentID), mentionID)
	pipe.SAdd(ctx, verse.MentionAckDirtyAgents, agentID)
	_, _ = pipe.Exec(ctx)
}
