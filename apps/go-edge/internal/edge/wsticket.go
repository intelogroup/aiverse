// WS ticket minting (routes/auth.ts POST /auth/ws-ticket,
// routes/owners.ts POST /owners/ws-ticket). The connect handlers redeem
// these tickets via GETDEL (verse.AgentTicketKey / OwnerTicketKey); the
// mints live here so an edge-served client can complete the whole flow
// against one host — an SDK derives both the mint and the connect from
// its gateway URL. Shapes mirror TS exactly: the ticket is 32 random
// bytes hex-encoded (64 chars), stored with a 60 s TTL, answered 201
// {ticket, expiresIn}.
package edge

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"aiverse/go-edge/internal/verse"
)

// wsTicketTTLSeconds is WS_TICKET_TTL_SECONDS (routes/auth.ts); the
// owner mint inlines the same 60 (routes/owners.ts).
const wsTicketTTLSeconds = 60

// apiPresenceTTLSeconds is API_PRESENCE_TTL_SECONDS (presence.ts): the
// TTL agentAuth's per-request presence touch writes.
const apiPresenceTTLSeconds = 180

// ── JWT (HS256) ──────────────────────────────────────────────────────
//
// Both TS session tokens (auth/agentSession.ts, auth/session.ts) are
// hono/jwt HS256 tokens over env.JWT_SECRET. Verification is small
// enough to hand-roll on the standard library rather than take a JWT
// dependency: pin the algorithm, compare the HMAC in constant time,
// then apply hono/jwt's claim checks (exp required-and-past rejects,
// nbf in the future rejects). A server with no secret configured fails
// closed — verifyHS256JWT errors for every token, so nothing can mint
// on an unverifiable credential.

// verifyHS256JWT returns the claims of a well-formed, correctly signed,
// currently valid HS256 token. Numbers decode as json.Number so the
// owner session's `sv` keeps exact integer semantics.
func verifyHS256JWT(secret, token string) (map[string]any, error) {
	if secret == "" {
		return nil, errors.New("jwt secret not configured")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("token is not three segments")
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerRaw, &header); err != nil {
		return nil, err
	}
	if header.Alg != "HS256" {
		return nil, errors.New("unexpected alg")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, errors.New("signature mismatch")
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(string(payloadRaw)))
	dec.UseNumber()
	var claims map[string]any
	if err := dec.Decode(&claims); err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if v, ok := claims["exp"]; ok {
		exp, err := claimNumberSeconds(v)
		if err != nil || exp <= now {
			return nil, errors.New("token expired")
		}
	}
	if v, ok := claims["nbf"]; ok {
		nbf, err := claimNumberSeconds(v)
		if err != nil || nbf > now {
			return nil, errors.New("token not yet valid")
		}
	}
	return claims, nil
}

func claimNumberSeconds(v any) (int64, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, errors.New("claim is not a number")
	}
	f, err := n.Float64()
	if err != nil {
		return 0, err
	}
	return int64(f), nil
}

func claimString(claims map[string]any, key string) string {
	s, _ := claims[key].(string)
	return s
}

// keyFingerprint is agentSession.ts's: the first 16 hex chars of the
// public key's SHA-256. Sessions bind to it, so rotating an agent's key
// silently kills its outstanding sessions.
func keyFingerprint(publicKey string) string {
	sum := sha256.Sum256([]byte(publicKey))
	return hex.EncodeToString(sum[:])[:16]
}

// hashAgentToken is auth/agentToken.ts's: SHA-256 hex of the raw token.
func hashAgentToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ── agent resolution (auth/resolveAgent.ts) ─────────────────────────

type agentAuthRow struct {
	ID        string
	Status    string
	OwnerID   *string
	PublicKey *string
}

func scanAgentAuthRow(row pgx.Row) (*agentAuthRow, error) {
	var a agentAuthRow
	err := row.Scan(&a.ID, &a.Status, &a.OwnerID, &a.PublicKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func loadAgentAuthByID(ctx context.Context, pool *pgxpool.Pool, agentID string) (*agentAuthRow, error) {
	return scanAgentAuthRow(pool.QueryRow(ctx,
		`SELECT id, status::text, owner_id, public_key FROM agents WHERE id = $1`, agentID))
}

func loadAgentAuthByKeyHash(ctx context.Context, pool *pgxpool.Pool, keyHash string) (*agentAuthRow, error) {
	return scanAgentAuthRow(pool.QueryRow(
		ctx, `SELECT id, status::text, owner_id, public_key FROM agents WHERE api_key_hash = $1`, keyHash))
}

// resolveAgentFromToken ports auth/resolveAgent.ts exactly: a
// three-segment token takes the JWT session path (and never falls
// through on failure); anything else is a legacy bearer token resolved
// by its stored hash. Nil means "no agent" — the caller answers 401.
func (s *Server) resolveAgentFromToken(ctx context.Context, token string) *agentAuthRow {
	if len(strings.Split(token, ".")) == 3 {
		claims, err := verifyHS256JWT(s.jwtSecret, token)
		if err != nil {
			return nil
		}
		agentID := claimString(claims, "sub")
		if agentID == "" {
			return nil
		}
		agent, err := loadAgentAuthByID(ctx, s.pool, agentID)
		if err != nil || agent == nil || agent.PublicKey == nil || *agent.PublicKey == "" {
			return nil
		}
		if keyFingerprint(*agent.PublicKey) != claimString(claims, "kfp") {
			return nil
		}
		s.logger.Printf("agent_auth agentId=%s authMethod=ed25519", agent.ID)
		return agent
	}
	agent, err := loadAgentAuthByKeyHash(ctx, s.pool, hashAgentToken(token))
	if err != nil || agent == nil {
		return nil
	}
	s.logger.Printf("agent_auth agentId=%s authMethod=legacy", agent.ID)
	return agent
}

// ── owner sessions (auth/session.ts verifyOwnerSession) ────────────

// verifyOwnerSession verifies the owner's session JWT and its `sv`
// revocation pin against the owners row: a deleted owner or a bumped
// session_version (logout-all, password change) kills the token.
func (s *Server) verifyOwnerSession(ctx context.Context, token string) (string, error) {
	claims, err := verifyHS256JWT(s.jwtSecret, token)
	if err != nil {
		return "", err
	}
	ownerID := claimString(claims, "sub")
	if ownerID == "" {
		return "", errors.New("session has no subject")
	}
	svRaw, ok := claims["sv"].(json.Number)
	if !ok {
		return "", errors.New("session predates revocation support")
	}
	svFloat, err := svRaw.Float64()
	if err != nil {
		return "", err
	}
	sv := int64(svFloat)
	if float64(sv) != svFloat {
		return "", errors.New("session version is not an integer")
	}
	var version int64
	err = s.pool.QueryRow(ctx,
		`SELECT session_version FROM owners WHERE id = $1`, ownerID).Scan(&version)
	if err != nil {
		return "", err
	}
	if version != sv {
		return "", errors.New("session revoked")
	}
	return ownerID, nil
}

// ── handlers ─────────────────────────────────────────────────────────

type wsTicketResponse struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expiresIn"`
}

// writeJSON mirrors Hono's c.json: same content type, same body shape.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

type visitEndedResponse struct {
	Error  string `json:"error"`
	Reason string `json:"reason,omitempty"`
}

// bearerToken mirrors the TS middlewares' header parse: only a
// "Bearer " prefix yields a token.
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return "", false
	}
	return h[len("Bearer "):], true
}

// mintTicket creates the ticket value (randomBytes(32) hex in TS) and
// stores it under the caller's key shape with the 60 s TTL.
func (s *Server) mintTicket(ctx context.Context, keyFn func(string) string, subjectID string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	ticket := hex.EncodeToString(raw)
	if err := s.rdb.Set(ctx, keyFn(ticket), subjectID, wsTicketTTLSeconds*time.Second).Err(); err != nil {
		return "", err
	}
	return ticket, nil
}

// handleAgentWSTicket is POST /auth/ws-ticket (routes/auth.ts) behind a
// port of middleware/agentAuth.ts, in its exact order: resolve the
// token (401), deliberate-status refusals (paused / unclaimed, 403),
// the visit gate (403 visit_ended, POST consumes one action), the API
// presence touch, then mint. Neither the handler nor agentAuth applies
// a rate limit, so none is added here.
func (s *Server) handleAgentWSTicket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token, ok := bearerToken(r)
	if !ok || s.pool == nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	agent := s.resolveAgentFromToken(ctx, token)
	if agent == nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if agent.Status == "paused" {
		writeJSONError(w, http.StatusForbidden, "agent_paused")
		return
	}
	if agent.Status == "unclaimed" {
		writeJSONError(w, http.StatusForbidden, "agent_unclaimed")
		return
	}
	visit, err := checkAndConsumeVisit(ctx, s.pool, agent.ID, r.Method, nowMs())
	if err != nil {
		s.logger.Printf("ws_ticket_visit_check_error agentId=%s err=%v", agent.ID, err)
		writeJSONError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if !visit.Allowed {
		if visit.Ended != nil {
			s.announceVisitEnded(ctx, *visit.Ended)
		}
		writeJSON(w, http.StatusForbidden, visitEndedResponse{Error: "visit_ended", Reason: visit.Reason})
		return
	}
	// Any authenticated call counts as presence (agentAuth) —
	// fire-and-forget, never worth failing the mint over.
	_ = s.rdb.Set(ctx, verse.PresenceKey(agent.ID), "1", apiPresenceTTLSeconds*time.Second).Err()

	ticket, err := s.mintTicket(ctx, verse.AgentTicketKey, agent.ID)
	if err != nil {
		s.logger.Printf("ws_ticket_mint_error agentId=%s err=%v", agent.ID, err)
		writeJSONError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusCreated, wsTicketResponse{Ticket: ticket, ExpiresIn: wsTicketTTLSeconds})
}

// handleOwnerWSTicket is POST /owners/ws-ticket (routes/owners.ts)
// behind middleware/ownerAuth.ts: a verified owner session (401 on any
// failure — missing, malformed, revoked, or unverifiable because no
// JWT_SECRET is configured) mints a console ticket.
func (s *Server) handleOwnerWSTicket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token, ok := bearerToken(r)
	if !ok || s.pool == nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	ownerID, err := s.verifyOwnerSession(ctx, token)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	ticket, err := s.mintTicket(ctx, verse.OwnerTicketKey, ownerID)
	if err != nil {
		s.logger.Printf("owner_ws_ticket_mint_error ownerId=%s err=%v", ownerID, err)
		writeJSONError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusCreated, wsTicketResponse{Ticket: ticket, ExpiresIn: wsTicketTTLSeconds})
}
