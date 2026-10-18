package edge

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// Socket lifecycle on transport death (8k-soak defect, 2026-10-18): when
// a client dies WITHOUT a WebSocket close handshake — process death, the
// kernel sends a bare TCP FIN — the server must still release the
// connection: unregister it AND close the OS socket. The soak showed
// thousands of server sockets parked in CLOSE_WAIT with their fds
// pinned until the accept loop wedged on "too many open files": the
// graceful paths (close frame, heartbeat timeout) cleaned up, the
// transport-death path did not.

// fdCount returns this process's open-fd count. The test server runs
// in-process, so its accepted sockets are counted here — the same
// observable that wedged in the soak.
func fdCount(t *testing.T) int {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("fd counting via /proc/self/fd is linux-only")
	}
	ents, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatalf("read /proc/self/fd: %v", err)
	}
	return len(ents)
}

func pollCond(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return cond()
}

func (ts *testServer) agentRegistered(agentID string) bool {
	ts.srv.mu.Lock()
	defer ts.srv.mu.Unlock()
	_, ok := ts.srv.agents[agentID]
	return ok
}

func TestTransportDeathReleasesConnection(t *testing.T) {
	ts := startTestServer(t)
	owner := seedOwner(t, ts.pool)
	agentID := seedAgent(t, ts.pool, &owner, "TransportDeathAgent", "offline", nil)

	base := fdCount(t)
	client := connectAgent(t, ts, agentID)
	if !ts.agentRegistered(agentID) {
		t.Fatalf("agent not registered after connect")
	}
	connected := fdCount(t)
	if connected <= base {
		t.Fatalf("fd count did not rise on connect: base=%d connected=%d", base, connected)
	}

	// Transport death: CloseNow drops the TCP connection with no WS
	// close frame — the soak's bench-kill shape.
	_ = client.ws.CloseNow()

	regGone := pollCond(10*time.Second, func() bool { return !ts.agentRegistered(agentID) })
	if !regGone {
		t.Errorf("registry still holds the agent 10s after transport death")
	}
	// +1 slack: the /proc/self/fd listing itself and pool jitter.
	fdsBack := pollCond(10*time.Second, func() bool { return fdCount(t) <= base+1 })
	if !fdsBack {
		t.Errorf("server socket not released 10s after transport death: fds=%d baseline=%d (CLOSE_WAIT leak)",
			fdCount(t), base)
	}
}
