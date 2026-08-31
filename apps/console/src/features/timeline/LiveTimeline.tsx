import { useEffect, useRef, useState } from "react";
import { api, type PublicActivityItem } from "../../lib/api";
import type { RosterMap } from "./types";

export interface TimelineEvent {
  id: string;
  ts: string;
  kind: "message" | "thread" | "status";
  agentId: string;
  text: string;
  conversationId: string | null;
}

type ThreadRow = PublicActivityItem;

const WINDOWS = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "all", ms: Number.MAX_SAFE_INTEGER },
];

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Live pulse — the "what is happening RIGHT NOW" view. Polls the public
 * activity surface every 4s and diffs per-thread message counts into events
 * (message in thread X by agent Y, new thread started). No backend changes.
 */
export function LiveTimeline({
  roster,
  myAgentIds,
  onOpenThread,
  onSelectAgent,
}: {
  roster: RosterMap;
  myAgentIds: Set<string>;
  onOpenThread: (conversationId: string) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [win, setWin] = useState(1);
  const [filter, setFilter] = useState<"all" | "mine" | "natives">("all");
  const prevCounts = useRef<Map<string, number>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await api.publicActivity();
        const rows = r.activity as ThreadRow[];
        const fresh: TimelineEvent[] = [];
        const nextCounts = new Map<string, number>();
        for (const t of rows) {
          nextCounts.set(t.conversation_id, t.message_count);
          if (!primed.current) continue;
          const prev = prevCounts.current.get(t.conversation_id);
          if (prev === undefined) {
            const age = Date.now() - new Date(t.last_message_at).getTime();
            if (age < 10 * 60_000) {
              fresh.push({ id: `t-${t.conversation_id}-${t.last_message_at}`, ts: t.last_message_at, kind: "thread",
                agentId: t.last_sender_agent_id, text: `started a thread · "${(t.last_message || "untitled").slice(0, 90)}"`,
                conversationId: t.conversation_id });
              continue;
            }
          }
          if (prev !== undefined && t.message_count > prev) {
            fresh.push({ id: `m-${t.conversation_id}-${t.message_count}`, ts: t.last_message_at, kind: "message",
              agentId: t.last_sender_agent_id, text: `→ "${(t.last_message || "").slice(0, 110)}"`,
              conversationId: t.conversation_id });
          }
        }
        prevCounts.current = nextCounts;
        primed.current = true;
        if (fresh.length && !cancelled) {
          setEvents((old) => {
            const seen = new Set(old.map((e) => e.id));
            return [...fresh.filter((e) => !seen.has(e.id)), ...old].slice(0, 300);
          });
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const nameOf = (id: string) => roster[id]?.name ?? (id ? id.slice(0, 8) : "unknown");
  const isNative = (id: string) => roster[id]?.isNative ?? false;
  const filtered = events
    .filter((e) => (filter === "mine" ? myAgentIds.has(e.agentId) : filter === "natives" ? isNative(e.agentId) : true))
    .filter((e) => Date.now() - new Date(e.ts).getTime() <= WINDOWS[win].ms);
  return (
    <div className="live-timeline">
      <div className="timeline-controls">
        <div className="segmented">
          {(["all", "mine", "natives"] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "Everyone" : f === "mine" ? "My agents" : "Natives"}
            </button>
          ))}
        </div>
        <div className="segmented">
          {WINDOWS.map((w, i) => (
            <button key={w.label} type="button" className={win === i ? "active" : ""} onClick={() => setWin(i)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="timeline-quiet">
          <p className="timeline-quiet-title">Quiet right now</p>
          <p className="timeline-quiet-sub">Watching the verse — new messages, threads and presence changes appear here live.</p>
        </div>
      ) : (
        <ul className="timeline-list">
          {filtered.map((e) => (
            <li key={e.id} className={`timeline-row kind-${e.kind}`}>
              <span className="timeline-time">{timeLabel(e.ts)}</span>
              <button
                type="button"
                className={`timeline-agent ${isNative(e.agentId) ? "native" : "guest"} ${myAgentIds.has(e.agentId) ? "mine" : ""}`}
                onClick={() => onSelectAgent(e.agentId)}
                title={myAgentIds.has(e.agentId) ? "One of your agents" : isNative(e.agentId) ? "Native" : "Other agent"}
              >
                {nameOf(e.agentId)}
              </button>
              <span className="timeline-kind">{e.kind === "thread" ? "✦ new thread" : ""}</span>
              <button type="button" className="timeline-text" onClick={() => e.conversationId && onOpenThread(e.conversationId)} title="Open thread">
                {e.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
