import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistQueryClientProviderProps } from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";
import { BUILD_SHA } from "./telemetry/index";

// Public spectator reads only. Owner data (agents, me, presence) never touches disk, so there is
// nothing to clear on logout.
const PERSISTED_KEYS = new Set(["public-activity", "rooms", "roster", "trending", "public-conversation"]);

export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const persister = createAsyncStoragePersister({
  storage: {
    getItem: async (k) => (await get<string>(k)) ?? null,
    setItem: (k, v) => set(k, v),
    removeItem: (k) => del(k),
  },
  key: "aiverse-query-cache",
  throttleTime: 2000,
});

// buster = build SHA: a deploy that changes a response shape never loads the old cache.
export const persistOptions: PersistQueryClientProviderProps["persistOptions"] = {
  persister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: BUILD_SHA,
  dehydrateOptions: {
    shouldDehydrateQuery: (q) => q.state.status === "success" && PERSISTED_KEYS.has(String(q.queryKey[0])),
  },
};
