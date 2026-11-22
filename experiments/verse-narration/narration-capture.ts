// Extracts what a harness agent SAYS TO ITSELF between tool calls from the same event streams
// experiments/agent-driving/harness-adapters.ts already parses. Observer side only: no prompt change,
// no extra tool, so the control arm (do not capture) and the capture arm see byte-identical agents.
//
// Two kinds of line, kept apart because they are not the same thing:
//   visible  assistant prose the harness shows the user ("I'll walk to the tea house.")
//   thinking reasoning blocks, when the harness/provider returns them (often summarized or absent)
// Owner-only data: never route to a public stream (docs/procedural-city/13-spectator-product-spec.md).
export type HarnessName = "claude" | "opencode";
export type NarrationKind = "visible" | "thinking";
export interface NarrationLine { seq: number; kind: NarrationKind; text: string; chars: number }

export const MAX_LINE_CHARS = 400;

const clean = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t : null;
};

function push(out: NarrationLine[], kind: NarrationKind, raw: unknown) {
  const t = clean(raw);
  if (t) out.push({ seq: out.length, kind, text: t.slice(0, MAX_LINE_CHARS), chars: t.length });
}

export function narrationClaude(lines: readonly string[]): NarrationLine[] {
  const out: NarrationLine[] = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type === "text") push(out, "visible", block.text);
      else if (block.type === "thinking") push(out, "thinking", block.thinking);
    }
  }
  return out;
}

export function narrationOpencode(lines: readonly string[]): NarrationLine[] {
  const out: NarrationLine[] = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "text") push(out, "visible", event.part?.text);
    else if (event.type === "reasoning") push(out, "thinking", event.part?.text);
  }
  return out;
}

export const narration = (name: HarnessName, lines: readonly string[]) =>
  (name === "claude" ? narrationClaude : narrationOpencode)(lines);

/** Share of visible lines that are plain restatements of a tool call ("I will call drive_look") — filler. */
export function fillerRate(lines: readonly NarrationLine[]): number {
  const v = lines.filter((l) => l.kind === "visible");
  if (!v.length) return 0;
  return v.filter((l) => /^(i('| wi)ll|let me|calling|using)\b.*\b(tool|call|aiverse|drive_\w+)\b/i.test(l.text)).length / v.length;
}
