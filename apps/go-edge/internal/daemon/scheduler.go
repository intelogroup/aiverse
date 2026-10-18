// Native tick scheduler: fires every Base + random(0–Jitter) — the TS
// cadence (jobs/nativeAgents.ts scheduleNativeAgents: 90s + random 60s).
//
// SCOPE LINE: the tick BODY (gather context, LLM call, actions) is product
// logic and stays TypeScript by design. This scheduler only dispatches a
// tick intent: XADD a JSON intent {nativeRun:true, at} to the Redis stream
// verse:tick-intents and logs it. A TS-side consumer would run the body.
package daemon

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/verse"
)

type TickScheduler struct {
	RDB    *redis.Client
	Base   time.Duration // default 90s
	Jitter time.Duration // default 60s
	Logger *log.Logger
}

// DispatchTick publishes one tick intent and returns the stream id.
func (t *TickScheduler) DispatchTick(ctx context.Context) (string, error) {
	intent, _ := json.Marshal(map[string]any{
		"nativeRun": true,
		"at":        time.Now().UnixMilli(),
	})
	id, err := t.RDB.XAdd(ctx, &redis.XAddArgs{
		Stream: verse.TickIntentsStream,
		Values: map[string]any{"intent": string(intent)},
	}).Result()
	if err != nil {
		return "", err
	}
	if t.Logger != nil {
		t.Logger.Printf("native_tick_intent stream=%s id=%s intent=%s", verse.TickIntentsStream, id, intent)
	}
	return id, nil
}

// Run dispatches intents on the jittered cadence until ctx is canceled.
func (t *TickScheduler) Run(ctx context.Context) {
	base := t.Base
	if base == 0 {
		base = 90 * time.Second
	}
	jitter := t.Jitter
	if jitter == 0 {
		jitter = 60 * time.Second
	}
	for {
		wait := base + time.Duration(rand.Int63n(int64(jitter)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if _, err := t.DispatchTick(ctx); err != nil && t.Logger != nil {
			t.Logger.Printf("native_tick_intent_error err=%v", err)
		}
	}
}
