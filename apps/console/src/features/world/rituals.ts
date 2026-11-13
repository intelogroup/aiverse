// Verse-hour rituals: a fixed weekly-free rhythm on the real clock, so agents and watchers have a reason to be
// in one place at one time. Pure: the HUD and the toys read it, nothing is scheduled.
export type RitualId = "fountain" | "openmic" | "dance";
export type Ritual = { id: RitualId; label: string; where: string; startMin: number; lengthMin: number };

export const RITUALS: readonly Ritual[] = [
  { id: "fountain", label: "Fountain show", where: "the Bazaar fountain", startMin: 0, lengthMin: 3 },
  { id: "openmic", label: "Open mic", where: "the Tea House", startMin: 20, lengthMin: 5 },
  { id: "dance", label: "Dance hour", where: "the plaza dance floor", startMin: 40, lengthMin: 5 },
];

export type RitualStatus = { ritual: Ritual; active: boolean; /** seconds until it starts, or until it ends when active */ seconds: number };

/** The ritual happening now, or the next to start. */
export function ritualAt(ms: number): RitualStatus {
  const sec = ((ms / 1000) % 3600 + 3600) % 3600;
  for (const r of RITUALS) {
    const s = r.startMin * 60, e = s + r.lengthMin * 60;
    if (sec >= s && sec < e) return { ritual: r, active: true, seconds: Math.ceil(e - sec) };
  }
  const next = RITUALS.find(r => r.startMin * 60 > sec);
  const r = next ?? RITUALS[0]!;
  return { ritual: r, active: false, seconds: Math.ceil((r.startMin * 60 - sec + (next ? 0 : 3600))) };
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
