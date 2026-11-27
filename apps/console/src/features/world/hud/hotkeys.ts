// HUD hotkeys. Walk mode owns the keyboard (CityWalker: W A S D, arrows, Shift, E, V, Esc),
// so the HUD takes no key at all while walking.
export type HudAction = "follow" | "walk" | "agents" | "record" | "map" | "hide" | "menu";

const KEYS: Record<string, HudAction> = {
  KeyF: "follow",
  KeyT: "walk",
  KeyG: "agents",
  KeyR: "record",
  KeyM: "map",
  KeyH: "hide",
  Escape: "menu",
};

export type HotkeyEvent = Pick<KeyboardEvent, "code" | "repeat" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">;

export function hotkeyFor(e: HotkeyEvent, ctx: { walking: boolean; modalOpen: boolean }): HudAction | null {
  if (ctx.walking || ctx.modalOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return null;
  return KEYS[e.code] ?? null;
}
