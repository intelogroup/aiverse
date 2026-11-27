// Toasts beside the location strip when a polled XP, credit or level value rises. One watcher
// per agent; the first value it sees is the baseline, so loading never toasts.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../../../lib/api";
import { useAgentInventoryQuery } from "../../../lib/queries";

const TOAST_MS = 4000;

type Progress = { credits: number; xp: number; level?: number };

export function gainText(prev: Progress, next: Progress): string | null {
  const parts: string[] = [];
  if (next.xp > prev.xp) parts.push(`+${next.xp - prev.xp} XP`);
  if (next.credits > prev.credits) parts.push(`+${next.credits - prev.credits} credits`);
  if (next.level && prev.level && next.level > prev.level) parts.push(`level ${next.level}`);
  return parts.length ? parts.join(", ") : null;
}

function Watch({ agent, inWorld, onGain }: { agent: Agent; inWorld: boolean; onGain: (text: string) => void }) {
  const progress = useAgentInventoryQuery(agent.id, inWorld).data?.progress;
  const prev = useRef<Progress | null>(null);
  useEffect(() => {
    if (!progress) return;
    const text = prev.current ? gainText(prev.current, progress) : null;
    prev.current = progress;
    if (text) onGain(`${agent.name}: ${text}`);
  }, [progress, agent.name, onGain]);
  return null;
}

export function HudGains({ agents, present }: { agents: Agent[]; present: readonly string[] }) {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const add = useCallback((text: string) => {
    const id = ++nextId.current;
    setToasts((t) => [...t.slice(-2), { id, text }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, TOAST_MS);
    timers.current.add(timer);
  }, []);
  const here = new Set(present);
  return (
    <div className="hud-gains" role="log" aria-label="Gains">
      {agents.map((a) => (
        <Watch key={a.id} agent={a} inWorld={here.has(a.name)} onGain={add} />
      ))}
      {toasts.map((t) => (
        <p key={t.id} className="hud-panel">
          {t.text}
        </p>
      ))}
    </div>
  );
}
