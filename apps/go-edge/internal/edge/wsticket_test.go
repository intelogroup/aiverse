package edge

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"aiverse/go-edge/internal/verse"
)

// WS ticket minting (wsticket.go) — mirrors the TS ws-ticket cases in
// apps/gateway/src/routes/auth.test.ts (valid session → 201
// {ticket, expiresIn}; missing/invalid session → 401; paused agent →
// 403), plus the owner mint in routes/owners.ts and the single-use
// redemption the connect handlers already enforce.

const testJWTSecret = "go-edge-wsticket-test-secret-0123456789ab"

func startTicketServer(t *testing.T) *testServer {
	t.Helper()
	return startTestServerWith(t, func(s *Server) { s.jwtSecret = testJWTSecret })
}

func httpBase(ts *testServer) string {
	return "http" + strings.TrimPrefix(ts.url, "ws")
}

// signTestJWT mints an HS256 token exactly the way hono/jwt's sign
// does (header {alg, typ}, raw base64url segments, HMAC-SHA256).
func signTestJWT(t *testing.T, secret string, claims map[string]any) string {
	t.Helper()
	enc := func(v any) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal jwt part: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	unsigned := enc(map[string]any{"alg": "HS256", "typ": "JWT"}) + "." + enc(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func agentSessionClaims(agentID, publicKey string, exp time.Time) map[string]any {
	return map[string]any{
		"sub": agentID,
		"kfp": keyFingerprint(publicKey),
		"exp": exp.Unix(),
	}
}

func ownerSessionClaims(ownerID string, sv int64, exp time.Time) map[string]any {
	return map[string]any{
		"sub": ownerID,
		"sv":  sv,
		"exp": exp.Unix(),
	}
}

// seedKeyedAgent seeds a claimed agent and gives it an Ed25519 public
// key in the stored shape (raw 32-byte key, base64url, no padding).
func seedKeyedAgent(t *testing.T, pool *pgxpool.Pool, ownerID *string, name, status string) (string, string) {
	t.Helper()
	id := seedAgent(t, pool, ownerID, name, status, nil)
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("rand: %v", err)
	}
	publicKey := base64.RawURLEncoding.EncodeToString(raw)
	if _, err := pool.Exec(context.Background(),
		`UPDATE agents SET public_key = $1 WHERE id = $2`, publicKey, id); err != nil {
		t.Fatalf("seed public key: %v", err)
	}
	return id, publicKey
}

func postTicket(t *testing.T, url, token string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var body map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("POST %s: body is not JSON: %q", url, raw)
		}
	}
	return resp.StatusCode, body
}

// ── agent mint ───────────────────────────────────────────────────────

func TestWSTicketAgentRoundTrip(t *testing.T) {
	ts := startTicketServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID, publicKey := seedKeyedAgent(t, ts.pool, &owner, "MintAgent", "offline")

	token := signTestJWT(t, testJWTSecret,
		agentSessionClaims(agentID, publicKey, time.Now().Add(time.Hour)))
	status, body := postTicket(t, httpBase(ts)+"/auth/ws-ticket", token)
	if status != http.StatusCreated {
		t.Fatalf("mint status = %d, want 201 (body %v)", status, body)
	}
	ticket, _ := body["ticket"].(string)
	if len(ticket) != 64 {
		t.Fatalf("ticket = %q, want 64 hex chars", ticket)
	}
	if _, err := hex.DecodeString(ticket); err != nil {
		t.Fatalf("ticket is not hex: %v", err)
	}
	if body["expiresIn"] != float64(60) {
		t.Fatalf("expiresIn = %v, want 60", body["expiresIn"])
	}
	// Stored under the exact key shape the connect path GETDELs, with
	// the 60 s TTL.
	stored, err := ts.rdb.Get(ctx, verse.AgentTicketKey(ticket)).Result()
	if err != nil || stored != agentID {
		t.Fatalf("stored ticket = %q, %v; want agent id", stored, err)
	}
	if ttl := ts.rdb.TTL(ctx, verse.AgentTicketKey(ticket)).Val(); ttl <= 0 || ttl > 60*time.Second {
		t.Fatalf("ticket TTL = %s, want (0, 60s]", ttl)
	}

	// Connect with the minted ticket over the real handler.
	c := dial(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))
	first := c.nextFrame(t, 5*time.Second)
	if got := frameType(t, first); got != verse.EventAgentConnected {
		t.Fatalf("first frame type = %q, want %q", got, verse.EventAgentConnected)
	}
	c.ws.CloseNow()

	// Single-use: the same ticket is rejected on the second connect.
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseInvalidTicket {
		t.Fatalf("second-connect close code = %d, want 4001", code)
	}
}

func TestWSTicketAgentUnauthorized(t *testing.T) {
	ts := startTicketServer(t)
	owner := seedOwner(t, ts.pool)
	agentID, publicKey := seedKeyedAgent(t, ts.pool, &owner, "MintAgent401", "offline")
	good := agentSessionClaims(agentID, publicKey, time.Now().Add(time.Hour))

	cases := map[string]string{
		"no token":        "",
		"garbage token":   "not-a-real-token",
		"wrong secret":    signTestJWT(t, "some-other-secret", good),
		"expired session": signTestJWT(t, testJWTSecret, agentSessionClaims(agentID, publicKey, time.Now().Add(-time.Minute))),
		// Signed against a different key than the row's live one —
		// key rotation invalidates outstanding sessions (kfp binding).
		"stale key fingerprint": signTestJWT(t, testJWTSecret,
			agentSessionClaims(agentID, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", time.Now().Add(time.Hour))),
		"unknown agent": signTestJWT(t, testJWTSecret,
			agentSessionClaims(uuid.NewString(), publicKey, time.Now().Add(time.Hour))),
	}
	for name, token := range cases {
		status, body := postTicket(t, httpBase(ts)+"/auth/ws-ticket", token)
		if status != http.StatusUnauthorized || body["error"] != "unauthorized" {
			t.Fatalf("%s: status = %d body = %v, want 401 unauthorized", name, status, body)
		}
		if _, minted := body["ticket"]; minted {
			t.Fatalf("%s: a ticket was minted on a rejected request", name)
		}
	}
}

func TestWSTicketAgentPaused(t *testing.T) {
	ts := startTicketServer(t)
	owner := seedOwner(t, ts.pool)
	agentID, publicKey := seedKeyedAgent(t, ts.pool, &owner, "MintPaused", "paused")

	token := signTestJWT(t, testJWTSecret,
		agentSessionClaims(agentID, publicKey, time.Now().Add(time.Hour)))
	status, body := postTicket(t, httpBase(ts)+"/auth/ws-ticket", token)
	if status != http.StatusForbidden || body["error"] != "agent_paused" {
		t.Fatalf("status = %d body = %v, want 403 agent_paused", status, body)
	}
}

func TestWSTicketAgentUnclaimedStatus(t *testing.T) {
	ts := startTicketServer(t)
	owner := seedOwner(t, ts.pool)
	agentID, publicKey := seedKeyedAgent(t, ts.pool, &owner, "MintUnclaimed", "unclaimed")

	token := signTestJWT(t, testJWTSecret,
		agentSessionClaims(agentID, publicKey, time.Now().Add(time.Hour)))
	status, body := postTicket(t, httpBase(ts)+"/auth/ws-ticket", token)
	if status != http.StatusForbidden || body["error"] != "agent_unclaimed" {
		t.Fatalf("status = %d body = %v, want 403 agent_unclaimed", status, body)
	}
}

func TestWSTicketAgentLegacyToken(t *testing.T) {
	ts := startTicketServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "MintLegacy", "offline", nil)
	rawToken := "legacy-token-" + uuid.NewString()
	if _, err := ts.pool.Exec(ctx,
		`UPDATE agents SET api_key_hash = $1 WHERE id = $2`, hashAgentToken(rawToken), agentID); err != nil {
		t.Fatalf("seed api key hash: %v", err)
	}

	status, body := postTicket(t, httpBase(ts)+"/auth/ws-ticket", rawToken)
	if status != http.StatusCreated {
		t.Fatalf("mint status = %d, want 201 (body %v)", status, body)
	}
	ticket, _ := body["ticket"].(string)
	stored, err := ts.rdb.Get(ctx, verse.AgentTicketKey(ticket)).Result()
	if err != nil || stored != agentID {
		t.Fatalf("stored ticket = %q, %v; want agent id", stored, err)
	}
}

func TestWSTicketAgentVisitEnded(t *testing.T) {
	ts := startTicketServer(t)
	owner := seedOwner(t, ts.pool)
	agentID, publicKey := seedKeyedAgent(t, ts.pool, &owner, "MintVisitEnded", "offline")
	endedAt := time.Now().Add(-time.Minute)
	seedVisit(t, ts.pool, agentID, owner, visitSeed{
		endsAt:      time.Now().Add(time.Hour),
		maxActions:  100,
		actionsUsed: 0,
		endedAt:     &endedAt,
		endedReason: "owner_stopped",
	})

	token := signTestJWT(t, testJWTSecret,
		agentSessionClaims(agentID, publicKey, time.Now().Add(time.Hour)))
	status, body := postTicket(t, httpBase(ts)+"/auth/ws-ticket", token)
	if status != http.StatusForbidden || body["error"] != "visit_ended" || body["reason"] != "owner_stopped" {
		t.Fatalf("status = %d body = %v, want 403 visit_ended/owner_stopped", status, body)
	}
}

// ── owner mint ───────────────────────────────────────────────────────

func ownerSessionVersion(t *testing.T, pool *pgxpool.Pool, ownerID string) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(context.Background(),
		`SELECT session_version FROM owners WHERE id = $1`, ownerID).Scan(&v); err != nil {
		t.Fatalf("read session_version: %v", err)
	}
	return v
}

func TestWSTicketOwnerRoundTrip(t *testing.T) {
	ts := startTicketServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	sv := ownerSessionVersion(t, ts.pool, owner)

	token := signTestJWT(t, testJWTSecret,
		ownerSessionClaims(owner, sv, time.Now().Add(7*24*time.Hour)))
	status, body := postTicket(t, httpBase(ts)+"/owners/ws-ticket", token)
	if status != http.StatusCreated {
		t.Fatalf("mint status = %d, want 201 (body %v)", status, body)
	}
	ticket, _ := body["ticket"].(string)
	if len(ticket) != 64 {
		t.Fatalf("ticket = %q, want 64 hex chars", ticket)
	}
	if body["expiresIn"] != float64(60) {
		t.Fatalf("expiresIn = %v, want 60", body["expiresIn"])
	}
	stored, err := ts.rdb.Get(ctx, verse.OwnerTicketKey(ticket)).Result()
	if err != nil || stored != owner {
		t.Fatalf("stored ticket = %q, %v; want owner id", stored, err)
	}
	if ttl := ts.rdb.TTL(ctx, verse.OwnerTicketKey(ticket)).Val(); ttl <= 0 || ttl > 60*time.Second {
		t.Fatalf("ticket TTL = %s, want (0, 60s]", ttl)
	}

	// Connect with the minted ticket over the real console handler.
	c := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, ticket))
	waitFor(t, "console registered", 3*time.Second, func() bool {
		ts.srv.mu.Lock()
		defer ts.srv.mu.Unlock()
		return len(ts.srv.consoles[owner]) == 1
	})
	c.ws.CloseNow()

	// Single-use: the same ticket is rejected on the second connect.
	if code := dialExpectClose(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, ticket)); code != CloseInvalidTicket {
		t.Fatalf("second-connect close code = %d, want 4001", code)
	}
}

func TestWSTicketOwnerBadJWT(t *testing.T) {
	ts := startTicketServer(t)
	owner := seedOwner(t, ts.pool)
	sv := ownerSessionVersion(t, ts.pool, owner)
	exp := time.Now().Add(time.Hour)

	noSV := ownerSessionClaims(owner, sv, exp)
	delete(noSV, "sv")

	cases := map[string]string{
		"no token":        "",
		"garbage token":   "not-a-real-token",
		"wrong secret":    signTestJWT(t, "some-other-secret", ownerSessionClaims(owner, sv, exp)),
		"expired session": signTestJWT(t, testJWTSecret, ownerSessionClaims(owner, sv, time.Now().Add(-time.Minute))),
		// session_version moved on (logout-all / password change):
		// the revocation pin no longer matches the row.
		"revoked session": signTestJWT(t, testJWTSecret, ownerSessionClaims(owner, sv+1, exp)),
		"missing sv":      signTestJWT(t, testJWTSecret, noSV),
		"unknown owner":   signTestJWT(t, testJWTSecret, ownerSessionClaims(uuid.NewString(), sv, exp)),
	}
	for name, token := range cases {
		status, body := postTicket(t, httpBase(ts)+"/owners/ws-ticket", token)
		if status != http.StatusUnauthorized || body["error"] != "unauthorized" {
			t.Fatalf("%s: status = %d body = %v, want 401 unauthorized", name, status, body)
		}
		if _, minted := body["ticket"]; minted {
			t.Fatalf("%s: a ticket was minted on a rejected request", name)
		}
	}
}

func TestWSTicketOwnerFailsClosedWithoutSecret(t *testing.T) {
	// No JWT_SECRET configured: even a structurally perfect owner
	// session cannot verify, so the mint must refuse — never mint on
	// an unverifiable credential.
	ts := startTestServerWith(t, func(s *Server) { s.jwtSecret = "" })
	owner := seedOwner(t, ts.pool)
	sv := ownerSessionVersion(t, ts.pool, owner)

	token := signTestJWT(t, testJWTSecret,
		ownerSessionClaims(owner, sv, time.Now().Add(time.Hour)))
	status, body := postTicket(t, httpBase(ts)+"/owners/ws-ticket", token)
	if status != http.StatusUnauthorized || body["error"] != "unauthorized" {
		t.Fatalf("status = %d body = %v, want 401 unauthorized", status, body)
	}
}
