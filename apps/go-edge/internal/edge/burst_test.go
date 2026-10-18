package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"aiverse/go-edge/internal/verse"
)

// Burst defenses (PHASE0_SPEC §2) — mirrors the "burst defenses" block
// of the TS ws/registerFirst.test.ts plus the register-first refusal
// semantics (restore / no-restore) the TS failSetup implements.

// dialRaw connects and returns the socket without a background reader,
// so the test can read the server's close code directly off it.
func dialRaw(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return ws
}

// readClose reads until the server closes and returns (code, reason).
func readClose(t *testing.T, ws *websocket.Conn) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, _, err := ws.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				return int(ce.Code), ce.Reason
			}
			t.Fatalf("read: %v (not a close error)", err)
		}
	}
}

func TestReconnectBudget4009(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "BudgetAgent", "offline", nil)

	// 30 connects inside the window are within budget: each reaches
	// agent_connected (the TS (c) shape).
	for i := 1; i <= 30; i++ {
		ticket := seedAgentTicket(t, ts.rdb, agentID)
		ws := dialRaw(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))
		_, first, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("connect %d: read: %v", i, err)
		}
		if got := frameType(t, first); got != verse.EventAgentConnected {
			t.Fatalf("connect %d: first frame = %q, want agent_connected", i, got)
		}
		ws.CloseNow()
	}

	// The 31st closes 4009 with a parseable retry_after_ms hint in
	// (0, window].
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	ws := dialRaw(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))
	code, reason := readClose(t, ws)
	if code != CloseReconnectBudget {
		t.Fatalf("31st connect close code = %d, want 4009", code)
	}
	var hint struct {
		RetryAfterMs int64 `json:"retry_after_ms"`
	}
	if err := json.Unmarshal([]byte(reason), &hint); err != nil {
		t.Fatalf("4009 reason %q does not parse as JSON: %v", reason, err)
	}
	if hint.RetryAfterMs <= 0 || hint.RetryAfterMs > reconnectBudgetWindowSeconds*1000 {
		t.Fatalf("retry_after_ms = %d, want (0, 300000]", hint.RetryAfterMs)
	}

	// The budget lives at the TS key shape, and the shed connect left
	// no registered conn behind.
	if n, err := ts.rdb.Get(ctx, verse.ReconnectBudgetKey(agentID)).Int64(); err != nil || n != 31 {
		t.Fatalf("budget counter = %d (err=%v), want 31", n, err)
	}
	waitFor(t, "no conn registered after the shed connect", 3*time.Second, func() bool {
		return ts.srv.AgentCount() == 0
	})
}

func TestConnectAdmission503(t *testing.T) {
	// Shrink the bucket to a deterministic size: 3 tokens, no refill.
	// The bucket re-clamps to the env cap on every check, so connects
	// made by other tests (other Server instances) cannot leak in.
	t.Setenv("AIVERSE_WS_CONNECT_BURST", "3")
	t.Setenv("AIVERSE_WS_CONNECT_RATE_PER_SEC", "0")
	ts := startTestServer(t)
	httpURL := "http" + strings.TrimPrefix(ts.url, "ws")

	statuses := make([]int, 0, 6)
	var retryAfter string
	for i := 0; i < 6; i++ {
		resp, err := http.Get(httpURL + "/agents/ws?ticket=admission-probe")
		if err != nil {
			t.Fatalf("probe %d: %v", i, err)
		}
		statuses = append(statuses, resp.StatusCode)
		if resp.StatusCode == http.StatusServiceUnavailable {
			retryAfter = resp.Header.Get("Retry-After")
		}
		resp.Body.Close()
	}
	// The first 3 are admitted — they proceed to the upgrade handler
	// and fail there as non-upgrade requests, i.e. anything but 503.
	// The rest are shed before the socket ever opens.
	for i, s := range statuses[:3] {
		if s == http.StatusServiceUnavailable {
			t.Fatalf("probe %d status = 503, want admitted (statuses %v)", i, statuses)
		}
	}
	for i, s := range statuses[3:] {
		if s != http.StatusServiceUnavailable {
			t.Fatalf("probe %d status = %d, want 503 (statuses %v)", i+3, s, statuses)
		}
	}
	if retryAfter != "1" {
		t.Fatalf("Retry-After = %q, want %q", retryAfter, "1")
	}
}

// A gate refusal that says nothing about the incumbent restores it
// untouched (TS registerFirst (b1)-shape): the paused gate fires for
// the NEW connect; the incumbent keeps its registration, its presence,
// and its fanout delivery.
func TestGateFailureRestoresIncumbent(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "RestoreAgent", "offline", nil)

	incumbent := connectAgent(t, ts, agentID)

	// The agent is paused after the incumbent connected; a fresh
	// connect attempt now hits the 4003 gate.
	if _, err := ts.pool.Exec(ctx, `UPDATE agents SET status = 'paused' WHERE id = $1`, agentID); err != nil {
		t.Fatal(err)
	}
	ticket := seedAgentTicket(t, ts.rdb, agentID)
	if code := dialExpectClose(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket)); code != CloseAgentPaused {
		t.Fatalf("second connect close code = %d, want 4003", code)
	}

	// The incumbent survived the refusal: still registered, presence
	// intact, and fanout still reaches it.
	if got := ts.srv.AgentCount(); got != 1 {
		t.Fatalf("AgentCount = %d, want 1 (incumbent restored)", got)
	}
	if exists, _ := ts.rdb.Exists(ctx, verse.PresenceKey(agentID)).Result(); exists != 1 {
		t.Fatal("incumbent presence key lost after the refused connect")
	}
	ts.srv.PublishFanout(ctx, verse.FanoutMessage{
		Kind:    "agent",
		AgentID: agentID,
		Event:   verse.NewEnvelope(verse.EventRateLimited, map[string]any{"marker": "still-here"}).Bytes(),
	})
	got := incumbent.nextFrameOfType(t, verse.EventRateLimited, 3*time.Second)
	if !strings.Contains(string(got), "still-here") {
		t.Fatalf("incumbent fanout frame = %s", got)
	}
	incumbent.ws.CloseNow()
}

// A visit-ended refusal does NOT restore the incumbent (TS failSetup's
// restoreDisplaced=false): the visit is over for the incumbent too, so
// both sockets close 4008.
func TestVisitEndedRefusalClosesIncumbent(t *testing.T) {
	ts := startTestServer(t)
	ctx := context.Background()
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "VisitRefusalAgent", "offline", nil)

	incumbent := dialRaw(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, seedAgentTicket(t, ts.rdb, agentID)))
	_, first, err := incumbent.Read(ctx)
	if err != nil || frameType(t, first) != verse.EventAgentConnected {
		t.Fatalf("incumbent first frame = %s (err=%v)", first, err)
	}

	// A visit that has already expired (not yet swept): the next
	// connect's GET check ends it on the spot and refuses.
	seedVisit(t, ts.pool, agentID, owner, visitSeed{
		endsAt: time.Now().Add(-time.Minute), maxActions: 100, actionsUsed: 0,
	})

	ticket := seedAgentTicket(t, ts.rdb, agentID)
	ws := dialRaw(t, fmt.Sprintf("%s/agents/ws?ticket=%s", ts.url, ticket))
	if code, _ := readClose(t, ws); code != CloseVisitEnded {
		t.Fatalf("new connect close code = %d, want 4008", code)
	}
	if code, _ := readClose(t, incumbent); code != CloseVisitEnded {
		t.Fatalf("incumbent close code = %d, want 4008 (no restore on visit end)", code)
	}
	waitFor(t, "no conn registered after visit refusal", 3*time.Second, func() bool {
		return ts.srv.AgentCount() == 0
	})
}
