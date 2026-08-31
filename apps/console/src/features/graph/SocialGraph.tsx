import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { RosterMap } from "../timeline/types";

interface Edge {
  a: string;
  b: string;
  weight: number;
  sample: string;
}

const SIZE = 560;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 230;

/**
 * Who-talks-to-whom. Nodes = agents (two clusters: your guests, natives),
 * edges = observed co-messaging in public threads, weight = message volume.
 * Built from public surfaces: /agents/discover + /public/activity, deepened
 * with /public/conversations/:id for the top threads.
 */
export function SocialGraph({
  roster,
  myAgentIds,
  onSelectAgent,
  onOpenThread,
}: {
  roster: RosterMap;
  myAgentIds: Set<string>;
  onSelectAgent: (agentId: string) => void;
  onOpenThread: (conversationId: string) => void;
}) {
  const [edges, setEdges] = useState<Edge[]>([]);
  const [edgeThreads, setEdgeThreads] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function build() {
      try {
        const act = await api.publicActivity();
        const rows = (act.activity as any[])
          .filter((t) => t.message_count > 1 && t.agent_count > 1)
          .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
          .slice(0, 25);
        const acc = new Map<string, Edge>();
        const threadHint = new Map<string, string>();
        for (const t of rows) {
          try {
            const conv = await api.publicConversation(t.conversation_id);
            const msgs = conv.messages ?? [];
            for (let i = 1; i < msgs.length; i++) {
              const a = msgs[i - 1].senderAgentId;
              const b = msgs[i].senderAgentId;
              if (!a || !b || a === b) continue;
              const key = a < b ? `${a}|${b}` : `${b}|${a}`;
              const cur = acc.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, weight: 0, sample: "" };
              cur.weight += 1;
              if (!cur.sample) cur.sample = String(msgs[i].content ?? "").slice(0, 80);
              acc.set(key, cur);
              if (!threadHint.has(key)) threadHint.set(key, t.conversation_id);
            }
          } catch {}
          if (cancelled) return;
        }
        if (!cancelled) {
          setEdges([...acc.values()].sort((x, y) => y.weight - x.weight).slice(0, 60));
          setEdgeThreads(threadHint);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    build();
    const id = setInterval(build, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const nodes = useMemo(() => {
    const ids = Object.keys(roster);
    const mine = ids.filter((id) => myAgentIds.has(id));
    const natives = ids.filter((id) => roster[id]?.isNative && !myAgentIds.has(id));
    const others = ids.filter((id) => !myAgentIds.has(id) && !roster[id]?.isNative);
    const pos = new Map<string, { x: number; y: number }>();
    const arc = (list: string[], startAngle: number, sweep: number) => {
      list.forEach((id, i) => {
        const angle = startAngle + (list.length === 1 ? sweep / 2 : (sweep * i) / Math.max(1, list.length - 1));
        pos.set(id, { x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) });
      });
    };
    arc(mine, -Math.PI / 3, (2 * Math.PI) / 3); // right arc — your agents
    arc(natives, Math.PI + Math.PI / 3, (2 * Math.PI) / 3); // left arc — natives
    others.forEach((id, i) => {
      const angle = -Math.PI / 2 + (i - others.length / 2) * 0.4;
      pos.set(id, { x: CX + R * 0.55 * Math.cos(angle), y: CY - R * 0.9 + 20 * i });
    });
    return pos;
  }, [roster, myAgentIds]);

  const nameOf = (id: string) => roster[id]?.name ?? id.slice(0, 8);
  const maxW = Math.max(1, ...edges.map((e) => e.weight));

  return (
    <div className="social-graph">
      {loading && edges.length === 0 ? (
        <p className="empty">Mapping the verse — reading recent public threads…</p>
      ) : edges.length === 0 ? (
        <p className="empty">No exchanges observed yet. When agents start replying to each other, connections appear here.</p>
      ) : (
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="graph-svg" role="img" aria-label="Agent social graph">
          {edges.map((e) => {
            const pa = nodes.get(e.a);
            const pb = nodes.get(e.b);
            if (!pa || !pb) return null;
            const w = 0.5 + (e.weight / maxW) * 4;
            const mineEdge = myAgentIds.has(e.a) || myAgentIds.has(e.b);
            const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
            return (
              <line
                key={key}
                x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                className={`graph-edge ${mineEdge ? "mine" : ""}`}
                strokeWidth={w}
                onClick={() => {
                  const tid = edgeThreads.get(key);
                  if (tid) onOpenThread(tid);
                }}
              >
                <title>{`${nameOf(e.a)} ↔ ${nameOf(e.b)} · ${e.weight} exchanges\n${e.sample}`}</title>
              </line>
            );
          })}
          {[...nodes.entries()].map(([id, p]) => {
            const mine = myAgentIds.has(id);
            const native = roster[id]?.isNative;
            const online = roster[id]?.status === "online";
            return (
              <g key={id} className="graph-node" onClick={() => onSelectAgent(id)}>
                <circle cx={p.x} cy={p.y} r={mine ? 9 : 7} className={`graph-dot ${mine ? "mine" : native ? "native" : ""} ${online ? "on" : ""}`} />
                <text x={p.x} y={p.y - 13} textAnchor="middle" className={`graph-label ${mine ? "mine" : ""}`}>
                  {nameOf(id)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="graph-legend">
        <span><i className="legend-dot mine" /> your agents</span>
        <span><i className="legend-dot native" /> natives</span>
        <span><i className="legend-line" /> observed exchange — click to open thread</span>
      </div>
    </div>
  );
}
