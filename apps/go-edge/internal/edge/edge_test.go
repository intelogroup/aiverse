package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/verse"
)

// Integration tests against the local stack: Postgres (aiverse_test, the
// gateway's own migrations) + Redis on 127.0.0.1. They skip when either is
// unreachable so `go test ./...` stays green on machines without it.
// DSN override: GO_EDGE_TEST_DATABASE_URL.

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("redis unavailable: %v", err)
	}
	t.Cleanup(func() { rdb.Close() })
	return rdb
}

func testDSN() string {
	if v := os.Getenv("GO_EDGE_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://postgres@127.0.0.1:5433/aiverse_test"
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, testDSN())
	if err != nil {
		t.Skipf("pgxpool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type testServer struct {
	srv  *Server
	url  string
	rdb  *redis.Client
	pool *pgxpool.Pool
	stop context.CancelFunc
}

func startTestServer(t *testing.T) *testServer {
	t.Helper()
	return startTestServerWith(t, nil)
}

// startTestServerWith lets a test adjust Server fields (heartbeat
// interval, digest flush triggers, backlog delay) before the fanout and
// digest loops start — they read the fields once at StartFanout.
func startTestServerWith(t *testing.T, tune func(*Server)) *testServer {
	t.Helper()
	rdb := testRedis(t)
	pool := testPool(t)
	s := NewServer(rdb, pool, nil)
	if tune != nil {
		tune(s)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.StartFanout(ctx)
	httpSrv := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		cancel()
		httpSrv.Close()
	})
	return &testServer{
		srv:  s,
		url:  "ws" + strings.TrimPrefix(httpSrv.URL, "http"),
		rdb:  rdb,
		pool: pool,
		stop: cancel,
	}
}

type testClient struct {
	ws     *websocket.Conn
	frames chan []byte
}

func dial(t *testing.T, url string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	c := &testClient{ws: ws, frames: make(chan []byte, 256)}
	go func() {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				close(c.frames)
				return
			}
			c.frames <- data
		}
	}()
	t.Cleanup(func() { ws.CloseNow() })
	return c
}

// dialExpectClose dials and returns the server's close code.
func dialExpectClose(t *testing.T, url string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	defer ws.CloseNow()
	_, _, err = ws.Read(ctx)
	return int(websocket.CloseStatus(err))
}

func (c *testClient) nextFrame(t *testing.T, timeout time.Duration) []byte {
	t.Helper()
	select {
	case data, ok := <-c.frames:
		if !ok {
			t.Fatal("connection closed while waiting for a frame")
		}
		return data
	case <-time.After(timeout):
		t.Fatalf("no frame within %s", timeout)
		return nil
	}
}

// nextFrameOfType skips frames until one of the wanted type arrives.
func (c *testClient) nextFrameOfType(t *testing.T, want string, timeout time.Duration) []byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("no %q frame within %s", want, timeout)
		}
		raw := c.nextFrame(t, remaining)
		if frameType(t, raw) == want {
			return raw
		}
	}
}

// collectFrames gathers everything arriving within the window.
func (c *testClient) collectFrames(window time.Duration) [][]byte {
	var out [][]byte
	timer := time.NewTimer(window)
	defer timer.Stop()
	for {
		select {
		case data, ok := <-c.frames:
			if !ok {
				return out
			}
			out = append(out, data)
		case <-timer.C:
			return out
		}
	}
}

func (c *testClient) expectNoFrame(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case data, ok := <-c.frames:
		if ok {
			t.Fatalf("unexpected frame: %s", data)
		}
	case <-time.After(timeout):
	}
}

func (c *testClient) send(t *testing.T, v any) {
	t.Helper()
	raw, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func frameType(t *testing.T, raw []byte) string {
	t.Helper()
	var f struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("bad frame json: %v (%s)", err, raw)
	}
	return f.Type
}

func framePayload(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var f struct {
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("bad frame json: %v (%s)", err, raw)
	}
	return f.Payload
}

// ── seeding ─────────────────────────────────────────────────────────────

func seedOwner(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO owners (email, password_hash) VALUES ($1, 'x') RETURNING id`,
		fmt.Sprintf("go-edge-%s@example.com", uuid.NewString()),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	return id
}

// seedAgent inserts an agent row; ownerID may be nil (unclaimed).
func seedAgent(t *testing.T, pool *pgxpool.Pool, ownerID *string, name, status string, capabilities []string) string {
	t.Helper()
	if capabilities == nil {
		capabilities = []string{}
	}
	card, _ := json.Marshal(map[string]any{"capabilities": capabilities})
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO agents (owner_id, name, agent_card, status, api_key_hash)
		 VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
		ownerID, name, string(card), status, "hash-"+uuid.NewString(),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	return id
}

func seedAgentTicket(t *testing.T, rdb *redis.Client, agentID string) string {
	t.Helper()
	ticket := uuid.NewString()
	if err := rdb.Set(context.Background(), verse.AgentTicketKey(ticket), agentID, time.Minute).Err(); err != nil {
		t.Fatalf("seed ticket: %v", err)
	}
	return ticket
}

func seedOwnerTicket(t *testing.T, rdb *redis.Client, ownerID string) string {
	t.Helper()
	ticket := uuid.NewString()
	if err := rdb.Set(context.Background(), verse.OwnerTicketKey(ticket), ownerID, time.Minute).Err(); err != nil {
		t.Fatalf("seed owner ticket: %v", err)
	}
	return ticket
}

// connectAgent dials /agents/ws with a fresh ticket and waits for the
// agent_connected frame (the server's own registration ack).
func connectAgent(t *testing.T, ts *testServer, agentID string) *testClient {
	t.Helper()
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	c := dial(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))
	first := c.nextFrame(t, 5*time.Second)
	if got := frameType(t, first); got != verse.EventAgentConnected {
		t.Fatalf("first frame type = %q, want %q", got, verse.EventAgentConnected)
	}
	return c
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ── spike-era tests, adapted to parity (connect now requires a row) ────

func TestTicketSingleUse(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "TicketAgent", "offline", nil)
	ticket := seedAgentTicket(t, ts.rdb, agentID)

	// First connect consumes the ticket and gets agent_connected.
	c1 := dial(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))
	first := c1.nextFrame(t, 5*time.Second)
	if got := frameType(t, first); got != verse.EventAgentConnected {
		t.Fatalf("first frame type = %q, want %q", got, verse.EventAgentConnected)
	}
	c1.ws.CloseNow()

	// Second connect with the SAME ticket: GETDEL consumed it → 4001.
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseInvalidTicket {
		t.Fatalf("second-connect close code = %d, want 4001", code)
	}
	// A random ticket is rejected the same way.
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, uuid.NewString())); code != CloseInvalidTicket {
		t.Fatalf("bad-ticket close code = %d, want 4001", code)
	}
	// A ticket whose agent row does not exist → 4001 (TS `if (!agent)`).
	ghost := uuid.NewString()
	ghostTicket := seedAgentTicket(t, ts.rdb, ghost)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ghostTicket)); code != CloseInvalidTicket {
		t.Fatalf("ghost-agent close code = %d, want 4001", code)
	}
}

func TestPresenceLifecycle(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "PresenceAgent", "offline", nil)
	key := verse.PresenceKey(agentID)

	c := connectAgent(t, ts, agentID)

	// Set on connect, with a TTL (expiry is TTL-driven).
	ttl, err := ts.rdb.PTTL(ctx, key).Result()
	if err != nil || ttl <= 60*time.Second || ttl > 90*time.Second {
		t.Fatalf("presence TTL after connect = %v (err=%v), want (60s, 90s]", ttl, err)
	}

	// Refresh on pong: shrink the TTL, send a pong envelope, TTL restored.
	if err := ts.rdb.Expire(ctx, key, 30*time.Second).Err(); err != nil {
		t.Fatal(err)
	}
	c.send(t, verse.NewEnvelope(verse.EventPong, map[string]any{}))
	waitFor(t, "presence TTL refresh on pong", 3*time.Second, func() bool {
		ttl, _ := ts.rdb.PTTL(ctx, key).Result()
		return ttl > 60*time.Second
	})

	// DEL on close.
	c.ws.CloseNow()
	waitFor(t, "presence key deleted on close", 3*time.Second, func() bool {
		exists, _ := ts.rdb.Exists(ctx, key).Result()
		return exists == 0
	})
}

func TestFanoutRouting(t *testing.T) {
	// Small digest window so connect-time presence digests flush inside
	// the drain windows below instead of landing mid-assertion.
	ts := startTestServerWith(t, func(s *Server) { s.digestWindow = 100 * time.Millisecond })
	ctx := context.Background()

	owner := seedOwner(t, ts.pool)
	agentA := seedAgent(t, ts.pool, &owner, "FanoutA", "offline", nil)
	agentB := seedAgent(t, ts.pool, &owner, "FanoutB", "offline", nil)
	ownerTicket := seedOwnerTicket(t, ts.rdb, owner)

	a := connectAgent(t, ts, agentA)
	b := connectAgent(t, ts, agentB)
	console_ := dial(t, fmt.Sprintf("%s/console/ws?ticket=%s", ts.url, ownerTicket))
	pub := dial(t, fmt.Sprintf("%s/public/ws", ts.url))
	// Drain connect-time fanout (presence digests / status frames).
	a.collectFrames(400 * time.Millisecond)
	b.collectFrames(400 * time.Millisecond)
	console_.collectFrames(400 * time.Millisecond)

	publish := func(msg verse.FanoutMessage) {
		t.Helper()
		ts.srv.PublishFanout(ctx, msg)
	}
	marker := func(name string) []byte {
		return verse.NewEnvelope(verse.EventMessage, map[string]any{"marker": name}).Bytes()
	}

	// kind=agent → only A.
	publish(verse.FanoutMessage{Kind: "agent", AgentID: agentA, Event: marker("for-a")})
	if got := a.nextFrame(t, 3*time.Second); !strings.Contains(string(got), "for-a") {
		t.Fatalf("agent fanout: A got %s", got)
	}
	b.expectNoFrame(t, 300*time.Millisecond)
	console_.expectNoFrame(t, 100*time.Millisecond)
	pub.expectNoFrame(t, 100*time.Millisecond)

	// kind=broadcast except A → only B.
	publish(verse.FanoutMessage{Kind: "broadcast", ExceptAgentID: agentA, Event: marker("all-but-a")})
	if got := b.nextFrame(t, 3*time.Second); !strings.Contains(string(got), "all-but-a") {
		t.Fatalf("broadcast fanout: B got %s", got)
	}
	a.expectNoFrame(t, 300*time.Millisecond)

	// kind=console → only the owner's console socket.
	publish(verse.FanoutMessage{Kind: "console", OwnerID: owner, Event: marker("for-console")})
	if got := console_.nextFrame(t, 3*time.Second); !strings.Contains(string(got), "for-console") {
		t.Fatalf("console fanout: got %s", got)
	}
	a.expectNoFrame(t, 100*time.Millisecond)
	b.expectNoFrame(t, 100*time.Millisecond)

	// kind=public → only public sockets.
	publish(verse.FanoutMessage{Kind: "public", Event: marker("for-public")})
	if got := pub.nextFrame(t, 3*time.Second); !strings.Contains(string(got), "for-public") {
		t.Fatalf("public fanout: got %s", got)
	}
	a.expectNoFrame(t, 100*time.Millisecond)
	b.expectNoFrame(t, 100*time.Millisecond)
	console_.expectNoFrame(t, 100*time.Millisecond)
}

func TestAckStash(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "AckStashAgent", "offline", nil)
	c := connectAgent(t, ts, agentID)

	convID, msgID, mentionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	c.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"conversationId": convID, "messageId": msgID}))
	c.send(t, verse.NewEnvelope(verse.EventAck, map[string]any{"mentionId": mentionID}))

	// Neither row exists → both acks land in the early-ack stash.
	waitFor(t, "early-ack stash keys", 3*time.Second, func() bool {
		e1, _ := ts.rdb.Exists(ctx, verse.EarlyAckMsgKey(convID, agentID, msgID)).Result()
		e2, _ := ts.rdb.Exists(ctx, verse.EarlyAckMentionKey(mentionID)).Result()
		return e1 == 1 && e2 == 1
	})
	ttl, _ := ts.rdb.PTTL(ctx, verse.EarlyAckMsgKey(convID, agentID, msgID)).Result()
	if ttl <= 0 || ttl > verse.EarlyAckTTLSeconds*time.Second {
		t.Fatalf("early-ack TTL = %v, want (0, 86400s]", ttl)
	}
}
