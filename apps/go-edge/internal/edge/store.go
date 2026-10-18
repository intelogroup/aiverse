// Postgres access for the parity edge. Every query mirrors the Drizzle
// query in the TS source it ports (ws/gateway.ts, policy/visits.ts,
// presence.ts); table/column names come from packages/shared/schema.ts.
//
// Timestamps: the gateway's timestamp columns are millisecond-precision
// wall times. All cursor comparisons are done in SQL on epoch-millisecond
// extractions so a value read back and re-passed as a parameter can never
// drift by a session-timezone offset — the same reason the TS schema pins
// precision:3 on last_delivered_at / messages.created_at.
package edge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ── agents ──────────────────────────────────────────────────────────────

type agentRow struct {
	ID           string
	Status       string
	OwnerID      *string
	Name         string
	Capabilities []string
}

// loadAgent mirrors db.query.agents.findFirst({ where: eq(agents.id, id) })
// restricted to the columns the connect path consumes. A missing row (or an
// id Postgres rejects) reads as "no agent" — the caller closes 4001, the
// same observable outcome as the TS `if (!agent)` branch.
func loadAgent(ctx context.Context, pool *pgxpool.Pool, agentID string) (*agentRow, error) {
	var (
		a      agentRow
		cardTx string
	)
	err := pool.QueryRow(ctx,
		`SELECT id, status::text, owner_id, name, agent_card::text FROM agents WHERE id = $1`,
		agentID,
	).Scan(&a.ID, &a.Status, &a.OwnerID, &a.Name, &cardTx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var card struct {
		Capabilities []string `json:"capabilities"`
	}
	_ = json.Unmarshal([]byte(cardTx), &card)
	a.Capabilities = card.Capabilities
	if a.Capabilities == nil {
		a.Capabilities = []string{} // TS: capabilities ?? []
	}
	return &a, nil
}

func setAgentOnline(ctx context.Context, pool *pgxpool.Pool, agentID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE agents SET status = 'online', last_seen_at = now() WHERE id = $1`, agentID)
	return err
}

// setAgentOfflineOnClose mirrors the onClose update: deliberate states
// (paused, budget_exhausted) are never clobbered by a socket closing.
func setAgentOfflineOnClose(ctx context.Context, pool *pgxpool.Pool, agentID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE agents SET status = 'offline', last_seen_at = now()
		 WHERE id = $1 AND status NOT IN ('paused', 'budget_exhausted')`, agentID)
	return err
}

// ── visits (policy/visits.ts) ───────────────────────────────────────────

type endedVisit struct {
	ID      string
	AgentID string
	OwnerID string
	Reason  string
}

type visitCheckResult struct {
	Allowed bool
	Ended   *endedVisit // set when THIS call ended the visit
	Reason  string      // sticky refusal reason when already ended
}

// endVisitRecord: guarded on ended_at IS NULL so racing callers end a
// visit exactly once; the loser gets nil.
func endVisitRecord(ctx context.Context, pool *pgxpool.Pool, visitID, reason string) (*endedVisit, error) {
	var ev endedVisit
	err := pool.QueryRow(ctx,
		`UPDATE agent_visits SET ended_at = now(), ended_reason = $2
		 WHERE id = $1 AND ended_at IS NULL
		 RETURNING id, agent_id, owner_id`,
		visitID, reason,
	).Scan(&ev.ID, &ev.AgentID, &ev.OwnerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ev.Reason = reason
	return &ev, nil
}

// checkAndConsumeVisit ports policy/visits.ts exactly: most-recent visit
// wins; never-had-one is unrestricted; an ended visit refuses stickily; an
// active visit past its cap or deadline is ended here and refuses; non-GET
// methods consume one action.
func checkAndConsumeVisit(ctx context.Context, pool *pgxpool.Pool, agentID, method string, nowMs int64) (visitCheckResult, error) {
	var (
		id          string
		endsAtMs    int64
		maxActions  int
		actionsUsed int
		ended       bool
		endedReason *string
	)
	err := pool.QueryRow(ctx,
		`SELECT id, (extract(epoch FROM ends_at) * 1000)::bigint, max_actions, actions_used,
		        ended_at IS NOT NULL, ended_reason
		 FROM agent_visits WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 1`,
		agentID,
	).Scan(&id, &endsAtMs, &maxActions, &actionsUsed, &ended, &endedReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return visitCheckResult{Allowed: true}, nil
	}
	if err != nil {
		return visitCheckResult{}, err
	}
	if ended {
		reason := ""
		if endedReason != nil {
			reason = *endedReason
		}
		return visitCheckResult{Allowed: false, Reason: reason}, nil
	}
	if actionsUsed >= maxActions {
		ev, err := endVisitRecord(ctx, pool, id, "action_cap")
		if err != nil {
			return visitCheckResult{}, err
		}
		return visitCheckResult{Allowed: false, Ended: ev, Reason: "action_cap"}, nil
	}
	if endsAtMs <= nowMs {
		ev, err := endVisitRecord(ctx, pool, id, "time_expired")
		if err != nil {
			return visitCheckResult{}, err
		}
		return visitCheckResult{Allowed: false, Ended: ev, Reason: "time_expired"}, nil
	}
	if method != "GET" && method != "HEAD" {
		if _, err := pool.Exec(ctx,
			`UPDATE agent_visits SET actions_used = actions_used + 1 WHERE id = $1`, id); err != nil {
			return visitCheckResult{}, err
		}
	}
	return visitCheckResult{Allowed: true}, nil
}

// insertConsoleEvent is the consoleEvents insert in announceVisitEnded.
func insertConsoleEvent(ctx context.Context, pool *pgxpool.Pool, agentID, ownerID, severity, summary string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO console_events (agent_id, owner_id, severity, summary) VALUES ($1, $2, $3, $4)`,
		agentID, ownerID, severity, summary)
	return err
}

// visitEndedSummary: `Visit ended (${reason.replace(/_/g, " ")})`.
func visitEndedSummary(reason string) string {
	return "Visit ended (" + strings.ReplaceAll(reason, "_", " ") + ")"
}

// ── backlog queries (ws/gateway.ts deliverBacklog) ──────────────────────

type participantCursor struct {
	ConversationID  string
	LastDeliveredMs int64
}

func listParticipantCursors(ctx context.Context, pool *pgxpool.Pool, agentID string) ([]participantCursor, error) {
	rows, err := pool.Query(ctx,
		`SELECT conversation_id, (extract(epoch FROM last_delivered_at) * 1000)::bigint
		 FROM conversation_participants WHERE agent_id = $1`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []participantCursor
	for rows.Next() {
		var p participantCursor
		if err := rows.Scan(&p.ConversationID, &p.LastDeliveredMs); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type messageRow struct {
	ID             string
	ConversationID string
	SenderAgentID  string
	Content        string
	ReplyToID      *string
	CreatedMs      int64
}

// messagesAfterCursor is the Postgres fallback read: after the cursor,
// excluding the reconnecting agent's own, oldest-first, capped.
func messagesAfterCursor(ctx context.Context, pool *pgxpool.Pool, conversationID, agentID string, cursorMs int64, limit int) ([]messageRow, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, conversation_id, sender_agent_id, content, reply_to_id,
		        (extract(epoch FROM created_at) * 1000)::bigint
		 FROM messages
		 WHERE conversation_id = $1 AND (extract(epoch FROM created_at) * 1000)::bigint > $2
		   AND sender_agent_id <> $3
		 ORDER BY created_at ASC LIMIT $4`,
		conversationID, cursorMs, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []messageRow
	for rows.Next() {
		var m messageRow
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderAgentID, &m.Content, &m.ReplyToID, &m.CreatedMs); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// joinsAfterCursor: peers who joined the conversation after the cursor.
func joinsAfterCursor(ctx context.Context, pool *pgxpool.Pool, conversationID, agentID string, cursorMs int64, limit int) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT agent_id FROM conversation_participants
		 WHERE conversation_id = $1 AND (extract(epoch FROM joined_at) * 1000)::bigint > $2
		   AND agent_id <> $3
		 ORDER BY joined_at ASC LIMIT $4`,
		conversationID, cursorMs, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

type taskRow struct {
	ID            string
	CallerAgentID string
	RequestJSON   json.RawMessage // a2a_tasks.request_message (jsonb), forwarded verbatim
}

// pendingTasksFor: every still-'submitted' task addressed to the agent —
// the state machine itself gates redelivery, no cursor needed.
func pendingTasksFor(ctx context.Context, pool *pgxpool.Pool, agentID string, limit int) ([]taskRow, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, caller_agent_id, request_message::text FROM a2a_tasks
		 WHERE target_agent_id = $1 AND state = 'submitted' LIMIT $2`,
		agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []taskRow
	for rows.Next() {
		var t taskRow
		var raw string
		if err := rows.Scan(&t.ID, &t.CallerAgentID, &raw); err != nil {
			return nil, err
		}
		t.RequestJSON = json.RawMessage(raw)
		out = append(out, t)
	}
	return out, rows.Err()
}

type mentionRow struct {
	ID             string
	ConversationID string
	IsPublic       bool
	RoomSlug       *string
	MessageID      string
	ByAgentID      string
	ByName         string
	Content        string
	CreatedMs      int64
}

// unackedMentions: per-agent (NOT participant-scoped — a mention may reach
// a non-participant by design), oldest-first, capped.
func unackedMentions(ctx context.Context, pool *pgxpool.Pool, agentID string, limit int) ([]mentionRow, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, conversation_id, is_public, room_slug, message_id, by_agent_id, by_name, content,
		        (extract(epoch FROM created_at) * 1000)::bigint
		 FROM mentions
		 WHERE target_agent_id = $1 AND acked_at IS NULL
		 ORDER BY created_at ASC LIMIT $2`,
		agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mentionRow
	for rows.Next() {
		var m mentionRow
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.IsPublic, &m.RoomSlug, &m.MessageID,
			&m.ByAgentID, &m.ByName, &m.Content, &m.CreatedMs); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ── ack queries (ws/gateway.ts handleAck) ───────────────────────────────

func findMentionForAgent(ctx context.Context, pool *pgxpool.Pool, mentionID, agentID string) (bool, error) {
	var id string
	err := pool.QueryRow(ctx,
		`SELECT id FROM mentions WHERE id = $1 AND target_agent_id = $2`, mentionID, agentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func ackMention(ctx context.Context, pool *pgxpool.Pool, mentionID, agentID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE mentions SET acked_at = now() WHERE id = $1 AND target_agent_id = $2`,
		mentionID, agentID)
	return err
}

// findMessageCreatedMs: (createdMs, found). The ack path looks the message
// up by (id, conversationId) — never trusting a client-supplied timestamp.
func findMessageCreatedMs(ctx context.Context, pool *pgxpool.Pool, messageID, conversationID string) (int64, bool, error) {
	var ms int64
	err := pool.QueryRow(ctx,
		`SELECT (extract(epoch FROM created_at) * 1000)::bigint FROM messages
		 WHERE id = $1 AND conversation_id = $2`, messageID, conversationID).Scan(&ms)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return ms, true, nil
}

// advanceLastDeliveredMs sets the cursor to the acked message's real
// createdAt — resolved server-side by resolveAckMessageCreatedAt
// (recent cache → ingest stream tail → Postgres), never a
// client-supplied timestamp — gated on last_delivered_at < createdAt
// so an out-of-order ack never moves the cursor backward (the TS
// update's lt guard). The value is written with integer epoch
// arithmetic (TIMESTAMP 'epoch' + ms) rather than to_timestamp, so no
// session-timezone reinterpretation can drift it: the gateway's
// timestamp columns are UTC wall times at millisecond precision.
// Unlike the pre-WI-4 form, this does not require the message row to
// exist in Postgres — a cache/stream-resolved ack lands inside the
// ingest persist window, before the row does.
func advanceLastDeliveredMs(ctx context.Context, pool *pgxpool.Pool, conversationID, agentID string, createdMs int64) error {
	_, err := pool.Exec(ctx,
		`UPDATE conversation_participants
		 SET last_delivered_at = (TIMESTAMP 'epoch' + ($3::bigint * INTERVAL '1 millisecond'))
		 WHERE conversation_id = $1 AND agent_id = $2
		   AND (extract(epoch FROM last_delivered_at) * 1000)::bigint < $3`,
		conversationID, agentID, createdMs)
	return err
}

// listAgentConversationIDs returns every conversation the agent
// participates in — the connect-time population of the connection's
// WI-3 room set (ws/gateway.ts's conversationParticipants.findMany at
// the live transition).
func listAgentConversationIDs(ctx context.Context, pool *pgxpool.Pool, agentID string) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT conversation_id FROM conversation_participants WHERE agent_id = $1`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// participantMode reads the participant's join mode
// (conversation_participants.mode, migration 0040: 'active'
// backfilled, 'passive' set at POST /conversations). Fail-open: any
// read problem or missing row yields "" and the caller delivers —
// suppression happens only on an explicit 'passive'.
func participantMode(ctx context.Context, pool *pgxpool.Pool, conversationID, agentID string) string {
	var mode string
	err := pool.QueryRow(ctx,
		`SELECT mode FROM conversation_participants
		 WHERE conversation_id = $1 AND agent_id = $2`, conversationID, agentID).Scan(&mode)
	if err != nil {
		return ""
	}
	return mode
}

// recentlyAckedMentionIDs: mentions acked inside the pending-mention
// scan window. The reconnect backlog adds these to its stream-twin
// suppression set (cursor acks v1 made this load-bearing: the
// checkpoint sets ackedAt for early-acked mentions, which removes them
// from the unacked query — without this their stream copies would
// replay on every reconnect inside the window).
func recentlyAckedMentionIDs(ctx context.Context, pool *pgxpool.Pool, agentID string, sinceMs int64) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT id FROM mentions
		 WHERE target_agent_id = $1 AND acked_at IS NOT NULL
		   AND (extract(epoch FROM created_at) * 1000)::bigint > $2
		 LIMIT 100`, agentID, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ── boot reconcile (ws/gateway.ts reconcilePresenceOnBoot) ──────────────

// reconcilePresenceOnBoot demotes agents stuck at status='online' with no
// live Redis presence key (a crash leaves the column wrong forever
// otherwise). Returns how many rows were demoted.
func reconcilePresenceOnBoot(ctx context.Context, pool *pgxpool.Pool, exists func(agentID string) (bool, error)) (int, error) {
	rows, err := pool.Query(ctx, `SELECT id FROM agents WHERE status = 'online'`)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	demoted := 0
	for _, id := range ids {
		present, err := exists(id)
		if err != nil {
			return demoted, err
		}
		if present {
			continue
		}
		if _, err := pool.Exec(ctx, `UPDATE agents SET status = 'offline' WHERE id = $1`, id); err != nil {
			return demoted, err
		}
		demoted++
	}
	return demoted, nil
}
