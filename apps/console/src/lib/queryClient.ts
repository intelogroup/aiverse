import { QueryClient } from "@tanstack/react-query";

// Phase 0 of the console state migration (see
// goals/aiverse-production-optimization/files/CONSOLE-STATE-MAP.md):
// gateway-owned server state lives in TanStack Query behind these keys;
// UI state (Zustand) and the sim blackboard stay out of this cache.
//
// Defaults: freshness is driven by the WS pokes + explicit refetch
// intervals, not by window focus, so focus refetch is off (the pre-Query
// code never refetched on focus). Retry stays at the library default —
// Query's error state only surfaces after retries exhaust, which is what
// lets it replace the hand-rolled degraded-mode bookkeeping in the shell.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

// One key factory so producers (queries) and consumers (WS invalidation,
// setQueryData patches) can never drift apart. Activity is keyed by limit
// because the gateway caps it (default 30, max 50) and VerseFeed asks for
// 50 while the shell asks for the default — different payloads, different
// cache entries; identical requests share an entry and dedupe.
export const queryKeys = {
  agents: ["agents"] as const,
  me: ["me"] as const,
  liveEvents: ["live-events"] as const,
  publicActivity: (limit: number) => ["public-activity", limit] as const,
  rooms: ["rooms"] as const,
  roster: ["roster"] as const,
  roomPresence: (slug: string) => ["room-presence", slug] as const,
  publicConversation: (conversationId: string) => ["public-conversation", conversationId] as const,
  trending: (window: string) => ["trending", window] as const,
};
