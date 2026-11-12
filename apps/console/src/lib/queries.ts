import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { api, type Agent, type ConsoleEvent } from "./api";
import { queryKeys } from "./queryClient";

// Shared server-state hooks (Phase 1 of the state migration). Before this
// file, WorldView, PublicHomepage and VerseFeed each fetched the public
// activity/roster on their own poll timers with no dedupe; now identical
// reads share one cache entry and one request. Polls became
// refetchInterval; WS pokes became invalidateQueries calls at the call
// sites; the two WS payload patches App.tsx used to hand-roll over
// useState arrays live below as setQueryData helpers.

// The gateway's default page for /public/activity (its max is 50, which
// VerseFeed explicitly requests).
export const ACTIVITY_LIMIT_DEFAULT = 30;
export const ACTIVITY_LIMIT_FEED = 50;

export function useAgentsQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.listAgents(),
    enabled,
  });
}

export function useMeQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.me(),
    enabled,
  });
}

// The live-events list has no REST seed in the shell today — it starts
// empty and accumulates console-WS events only. The query stays disabled
// (never fetches); prependLiveEvent below is its only writer. staleTime
// Infinity documents that nothing here goes stale on a timer.
export function useLiveEventsQuery() {
  return useQuery({
    queryKey: queryKeys.liveEvents,
    queryFn: () => Promise.resolve([] as ConsoleEvent[]),
    enabled: false,
    staleTime: Infinity,
  });
}

export function usePublicActivityQuery(
  limit: number,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: queryKeys.publicActivity(limit),
    // The default-limit read keeps the exact pre-Query URL (no param).
    queryFn: () => api.publicActivity(limit === ACTIVITY_LIMIT_DEFAULT ? undefined : limit),
    select: (r) => r.activity,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useRoomsQuery() {
  return useQuery({
    queryKey: queryKeys.rooms,
    queryFn: () => api.listRooms(),
    select: (r) => r.rooms,
  });
}

export function useRosterQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.roster,
    queryFn: () => api.discoverRoster(),
    select: (r) => r.roster ?? [],
    enabled: options?.enabled ?? true,
  });
}

export function useRoomPresenceQuery(
  slug: string,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: queryKeys.roomPresence(slug),
    queryFn: () => api.roomPresence(slug),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function usePublicConversationQuery(
  conversationId: string | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: queryKeys.publicConversation(conversationId ?? ""),
    queryFn: () => api.publicConversation(conversationId!),
    select: (r) => r.messages,
    enabled: !!conversationId,
    refetchInterval: options?.refetchInterval ?? false,
    // Switching threads keeps the previous thread's messages on screen
    // until the new ones land — the exact behaviour the old setState-only-
    // on-success code had.
    placeholderData: keepPreviousData,
  });
}

export function useTrendingQuery(window: "1h" | "24h") {
  return useQuery({
    queryKey: queryKeys.trending(window),
    queryFn: () => api.trending(window),
    select: (r) => r.topics,
  });
}

// --- WS patch helpers (the App.tsx hand-patches, centralized) ---

// console_event: prepend to the live-events list, capped at 200 — the
// same update App.tsx used to apply to its useState array.
export function prependLiveEvent(qc: QueryClient, event: ConsoleEvent): void {
  qc.setQueryData<ConsoleEvent[]>(queryKeys.liveEvents, (prev) =>
    [event, ...(prev ?? [])].slice(0, 200),
  );
}

// agent_status_changed: map the status onto the cached agents list — the
// same patch App.tsx used to apply by hand. No-op before the list loads.
export function patchAgentStatus(
  qc: QueryClient,
  payload: { agent_id: string; status: string },
): void {
  qc.setQueryData<{ agents: Agent[] }>(queryKeys.agents, (prev) =>
    prev
      ? {
          agents: prev.agents.map((a) =>
            a.id === payload.agent_id ? { ...a, status: payload.status as Agent["status"] } : a,
          ),
        }
      : prev,
  );
}
