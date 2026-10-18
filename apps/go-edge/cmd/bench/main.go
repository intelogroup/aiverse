// cmd/bench is the production-shaped WS load harness for the spike.
//
// Shape (measured from prod 2026-10-17): message content p50 349B / p90
// 486B / max ~1KB; the harness pads content to a 50/40/10 mix of those
// sizes. It seeds single-use tickets directly in Redis (exactly what
// POST /auth/ws-ticket does: SET wsticket:agent:{uuid} agentId EX 60),
// opens N sockets to the server under test, then publishes fanout
// messages to Redis ws:fanout (kind=broadcast, envelope type "message",
// payload stamped with the publisher's wall-clock nanos). Every client
// timestamps receipt; because publisher and clients share this process
// and host, latencies are single-clock measurements.
//
// Output: one JSON object — deliveries, delivered/sec, latency
// p50/p90/p99/max, and (given -pid) the server process's peak RSS
// (VmHWM) and CPU seconds consumed during the run.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// content size mix: p50 349B, p90 486B, max ~1KB.
func contentSize(i int) int {
	switch {
	case i%10 < 5:
		return 349
	case i%10 < 9:
		return 486
	default:
		return 1024
	}
}

type result struct {
	Label             string  `json:"label"`
	Conns             int     `json:"conns"`
	Published         int     `json:"published"`
	Expected          int64   `json:"expected_deliveries"`
	Received          int64   `json:"received"`
	Lost              int64   `json:"lost"`
	ConnectWallMs     int64   `json:"connect_wall_ms"`
	PublishWallMs     int64   `json:"publish_wall_ms"`
	TotalWallMs       int64   `json:"total_wall_ms"`
	DeliveredPerSec   float64 `json:"delivered_per_sec"`
	P50Ms             float64 `json:"p50_ms"`
	P90Ms             float64 `json:"p90_ms"`
	P99Ms             float64 `json:"p99_ms"`
	MaxMs             float64 `json:"max_ms"`
	MeanMs            float64 `json:"mean_ms"`
	ServerPID         int     `json:"server_pid,omitempty"`
	ServerRSSPeakKB   int64   `json:"server_rss_peak_kb,omitempty"`
	ServerCPUSecDelta float64 `json:"server_cpu_sec_delta,omitempty"`
}

func main() {
	baseURL := flag.String("url", "ws://127.0.0.1:8080", "ws base URL of the server under test")
	path := flag.String("path", "/agents/ws", "ws path")
	n := flag.Int("n", 100, "concurrent connections")
	msgs := flag.Int("msgs", 200, "broadcast messages to publish")
	redisURL := flag.String("redis", "redis://127.0.0.1:6379", "redis URL")
	pid := flag.Int("pid", 0, "server pid for RSS/CPU sampling (0 = skip)")
	label := flag.String("label", "", "label for this run")
	idsFile := flag.String("ids-file", "", "file of agent UUIDs (one per line); generated + written if absent")
	out := flag.String("out", "", "write result JSON here (also printed)")
	connectPar := flag.Int("connect-par", 250, "parallel dial workers")
	waitReady := flag.Duration("wait-ready", 0, "wait until every client has received agent_connected (server-side registration) before publishing; 0 = don't wait")
	expect := flag.Int("expect", -1, "expected messages per client (default: same as -msgs; use with -msgs 0 for a connect-only peer)")
	drainTimeout := flag.Duration("drain-timeout", 90*time.Second, "max wait for deliveries")
	flag.Parse()

	ctx := context.Background()
	opt, err := redis.ParseURL(*redisURL)
	if err != nil {
		fatal(err)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		fatal(fmt.Errorf("redis: %w", err))
	}

	agentIDs, err := loadOrGenIDs(*idsFile, *n)
	if err != nil {
		fatal(err)
	}
	agentIDs = agentIDs[:*n]

	// ── seed tickets (SET wsticket:agent:{ticket} agentId EX 120) ──
	tickets := make([]string, *n)
	pipe := rdb.Pipeline()
	for i, id := range agentIDs {
		t := uuid.NewString()
		tickets[i] = t
		pipe.Set(ctx, "wsticket:agent:"+t, id, 120*time.Second)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		fatal(fmt.Errorf("seed tickets: %w", err))
	}

	// ── server stat baseline ──
	var cpuBefore float64
	if *pid > 0 {
		cpuBefore, _ = procCPUSeconds(*pid)
	}

	// ── connect ──
	type client struct {
		ws    *websocket.Conn
		lat   []float64
		ready atomic.Bool
	}
	clients := make([]*client, *n)
	var received atomic.Int64
	var readyCount atomic.Int64
	var connectErrs atomic.Int64
	sem := make(chan struct{}, *connectPar)
	var wg sync.WaitGroup
	connectStart := time.Now()
	for i := 0; i < *n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			dctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			ws, _, err := websocket.Dial(dctx, *baseURL+*path+"?ticket="+tickets[i], nil)
			cancel()
			if err != nil {
				connectErrs.Add(1)
				return
			}
			ws.SetReadLimit(1 << 20)
			c := &client{ws: ws}
			clients[i] = c
			go func() {
				for {
					_, data, err := ws.Read(context.Background())
					if err != nil {
						return
					}
					recvNs := time.Now().UnixNano()
					var frame struct {
						Type    string `json:"type"`
						Payload struct {
							PubNs int64 `json:"_pub_ns"`
						} `json:"payload"`
					}
					if err := json.Unmarshal(data, &frame); err != nil {
						continue
					}
					if frame.Type == "agent_connected" {
						if c.ready.CompareAndSwap(false, true) {
							readyCount.Add(1)
						}
						continue
					}
					if frame.Type == "ping" {
						pong, _ := json.Marshal(map[string]any{
							"type": "pong", "id": uuid.NewString(), "ts": time.Now().UnixMilli(), "payload": map[string]any{},
						})
						wctx, wcancel := context.WithTimeout(context.Background(), 5*time.Second)
						_ = ws.Write(wctx, websocket.MessageText, pong)
						wcancel()
						continue
					}
					if frame.Payload.PubNs > 0 {
						c.lat = append(c.lat, float64(recvNs-frame.Payload.PubNs)/1e6)
						received.Add(1)
					}
				}
			}()
		}(i)
	}
	wg.Wait()
	connectWall := time.Since(connectStart)
	if connectErrs.Load() > 0 {
		fmt.Fprintf(os.Stderr, "WARN: %d/%d connects failed\n", connectErrs.Load(), *n)
	}
	connected := 0
	for _, c := range clients {
		if c != nil {
			connected++
		}
	}
	if connected == 0 {
		fatal(fmt.Errorf("no connections established"))
	}
	// settle: let the server register every socket before publishing.
	time.Sleep(500 * time.Millisecond)
	fmt.Fprintf(os.Stderr, "connected %d\n", connected)
	if *waitReady > 0 {
		rdyDeadline := time.Now().Add(*waitReady)
		for readyCount.Load() < int64(connected) && time.Now().Before(rdyDeadline) {
			time.Sleep(100 * time.Millisecond)
		}
		fmt.Fprintf(os.Stderr, "ready %d/%d\n", readyCount.Load(), connected)
	}

	// ── publish ──
	expectPer := *msgs
	if *expect >= 0 {
		expectPer = *expect
	}
	expected := int64(connected) * int64(expectPer)
	runStart := time.Now()
	publishStart := time.Now()
	for i := 0; i < *msgs; i++ {
		size := contentSize(i)
		event := map[string]any{
			"type": "message",
			"id":   uuid.NewString(),
			"ts":   time.Now().UnixMilli(),
			"payload": map[string]any{
				"conversation_id": uuid.NewString(),
				"message_id":      uuid.NewString(),
				"sender_id":       uuid.NewString(),
				"content":         strings.Repeat("x", size),
				"reply_to_id":     nil,
				"ts":              time.Now().UnixMilli(),
				"_pub_ns":         time.Now().UnixNano(),
			},
		}
		fanout, _ := json.Marshal(map[string]any{"kind": "broadcast", "event": event})
		if err := rdb.Publish(ctx, "ws:fanout", fanout).Err(); err != nil {
			fatal(fmt.Errorf("publish: %w", err))
		}
	}
	publishWall := time.Since(publishStart)

	// ── drain ──
	deadline := time.Now().Add(*drainTimeout)
	for received.Load() < expected && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	totalWall := time.Since(runStart)

	// ── stats ──
	var all []float64
	for _, c := range clients {
		if c != nil {
			all = append(all, c.lat...)
		}
	}
	sort.Float64s(all)
	res := result{
		Label:           *label,
		Conns:           connected,
		Published:       *msgs,
		Expected:        expected,
		Received:        received.Load(),
		Lost:            expected - received.Load(),
		ConnectWallMs:   connectWall.Milliseconds(),
		PublishWallMs:   publishWall.Milliseconds(),
		TotalWallMs:     totalWall.Milliseconds(),
		DeliveredPerSec: float64(received.Load()) / totalWall.Seconds(),
	}
	if len(all) > 0 {
		res.P50Ms = pct(all, 0.50)
		res.P90Ms = pct(all, 0.90)
		res.P99Ms = pct(all, 0.99)
		res.MaxMs = all[len(all)-1]
		var sum float64
		for _, v := range all {
			sum += v
		}
		res.MeanMs = sum / float64(len(all))
	}
	if *pid > 0 {
		res.ServerPID = *pid
		if kb, err := procRSSPeakKB(*pid); err == nil {
			res.ServerRSSPeakKB = kb
		}
		if cpuAfter, err := procCPUSeconds(*pid); err == nil {
			res.ServerCPUSecDelta = round2(cpuAfter - cpuBefore)
		}
	}

	raw, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(raw))
	if *out != "" {
		_ = os.WriteFile(*out, raw, 0o644)
	}

	// close sockets
	for _, c := range clients {
		if c != nil {
			_ = c.ws.CloseNow()
		}
	}
}

func pct(sorted []float64, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(q*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return round2(sorted[idx])
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

func loadOrGenIDs(path string, n int) ([]string, error) {
	if path != "" {
		if raw, err := os.ReadFile(path); err == nil {
			var ids []string
			sc := bufio.NewScanner(strings.NewReader(string(raw)))
			for sc.Scan() {
				if s := strings.TrimSpace(sc.Text()); s != "" {
					ids = append(ids, s)
				}
			}
			if len(ids) >= n {
				return ids, nil
			}
		}
	}
	ids := make([]string, n)
	for i := range ids {
		ids[i] = uuid.NewString()
	}
	if path != "" {
		var b strings.Builder
		for _, id := range ids {
			b.WriteString(id + "\n")
		}
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

func procRSSPeakKB(pid int) (int64, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "VmHWM:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				return strconv.ParseInt(fields[1], 10, 64)
			}
		}
	}
	return 0, fmt.Errorf("VmHWM not found")
}

func procCPUSeconds(pid int) (float64, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	s := string(raw)
	closeParen := strings.LastIndex(s, ")")
	if closeParen < 0 {
		return 0, fmt.Errorf("bad stat")
	}
	fields := strings.Fields(s[closeParen+1:])
	// fields[0] is state (field 3); utime=field14 → idx 11, stime=field15 → idx 12.
	utime, err1 := strconv.ParseFloat(fields[11], 64)
	stime, err2 := strconv.ParseFloat(fields[12], 64)
	if err1 != nil || err2 != nil {
		return 0, fmt.Errorf("bad stat numbers")
	}
	const clkTck = 100.0
	return (utime + stime) / clkTck, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "bench fatal:", err)
	os.Exit(1)
}
