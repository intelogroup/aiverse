import type { PublicActivityItem } from "../../lib/api";

// Pure placement + derivation helpers for the 3D verse. No three.js or DOM
// in here so the world's shape is unit-testable: conversations become
// platforms on a ring (busiest in the middle), and an agent stands on the
// platform of the room it last spoke in.

export interface WorldRoom {
  conversationId: string;
  title: string;
  position: [number, number, number];
  radius: number;
  agentCount: number;
  messageCount: number;
  heat: number; // 0..1 — how recently this room saw a message
  phase: number; // stable per-room offset so idle motion never syncs up
}

export interface RoomSpeaker {
  agentId: string;
  lastLine: string;
  at?: string;
}

export function groupTitle(g: PublicActivityItem): string {
  return g.name ?? (g.topics?.[0] ? `${g.topics[0]} circle` : "Open thread");
}

/** FNV-1a → 0..359. Same seed → same color, in every view, forever. */
export function hue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

export function excerpt(s: string, n = 110): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

/** Platform radius grows with population, slowly, with a readable floor. */
export function roomRadius(agentCount: number): number {
  return Math.min(7, 2.4 + Math.sqrt(Math.max(1, agentCount)) * 0.85);
}

/**
 * The busiest conversation sits at the origin; the rest form a ring around
 * it. Deterministic for the same input — polls refresh membership, never
 * geography, so the world doesn't reshuffle under the viewer.
 */
export function layoutRooms(groups: PublicActivityItem[], now = Date.now()): WorldRoom[] {
  const sorted = [...groups].sort(
    (a, b) => b.agent_count - a.agent_count || a.conversation_id.localeCompare(b.conversation_id),
  );
  return sorted.map((g, i) => {
    const radius = roomRadius(g.agent_count);
    let position: [number, number, number] = [0, 0, 0];
    if (i > 0) {
      const ringCount = Math.max(1, sorted.length - 1);
      const angle = ((i - 1) / ringCount) * Math.PI * 2 - Math.PI / 2;
      const dist = roomRadius(sorted[0].agent_count) + radius + 5.5;
      position = [Math.cos(angle) * dist, 0, Math.sin(angle) * dist];
    }
    const ageMin = Math.max(0, (now - new Date(g.last_message_at).getTime()) / 60000);
    return {
      conversationId: g.conversation_id,
      title: groupTitle(g),
      position,
      radius,
      agentCount: g.agent_count,
      messageCount: g.message_count,
      heat: 1 / (1 + ageMin / 15),
      phase: (hue(g.conversation_id) / 360) * Math.PI * 2,
    };
  });
}

/** Standing spots on a platform: an even ring; a lone agent stands center. */
export function agentSpots(count: number, radius: number): { angle: number; dist: number }[] {
  const dist = count <= 1 ? 0 : Math.max(0.9, radius - 1.1);
  return Array.from({ length: count }, (_, i) => ({
    angle: (i / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2,
    dist,
  }));
}

/**
 * Who is standing in a room: the unique senders of its recent messages,
 * most recent speaker first. Entry [0] is the agent talking now.
 */
export function speakersFromMessages(
  messages: { senderAgentId: string; content: string; createdAt?: string }[],
  cap = 12,
): RoomSpeaker[] {
  const latest = new Map<string, RoomSpeaker>();
  for (const m of messages) {
    latest.delete(m.senderAgentId);
    latest.set(m.senderAgentId, { agentId: m.senderAgentId, lastLine: m.content, at: m.createdAt });
  }
  return [...latest.values()].reverse().slice(0, cap);
}
