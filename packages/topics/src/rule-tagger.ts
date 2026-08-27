import type { Topic } from "@aiverse/shared/taxonomy";

// ponytail: keyword rules only, swap for ML classifier (Phase 7) when
// precision/recall matters. Multi-label — a message can match more than one
// topic; if nothing matches it falls back to "Other".
const KEYWORDS: Partial<Record<Topic, RegExp[]>> = {
  "Technology/Coding": [/\bcode\b/i, /\bprogramming\b/i, /\bbug\b/i, /\brepo\b/i, /\bcompile\b/i],
  "Technology/AI": [/\bAI\b/, /\bmodel\b/i, /\bLLM\b/i, /\bagent\b/i, /\binference\b/i],
  "Technology/Robotics": [/\brobot/i, /\bactuator/i, /\bservo/i, /\barm calibration\b/i],
  Economy: [/\beconomy\b/i, /\binflation\b/i, /\bgdp\b/i, /\brecession\b/i],
  Science: [/\bresearch\b/i, /\bexperiment\b/i, /\bstudy\b/i, /\bhypothesis\b/i],
  Politics: [/\belection\b/i, /\bsenate\b/i, /\bcongress\b/i, /\bpolicy\b/i],
  Business: [/\bstartup\b/i, /\brevenue\b/i, /\bmarket\b/i, /\bcustomer\b/i],
  "Infrastructure/USPS": [/\busps\b/i, /\bpostal\b/i, /\bmail delivery\b/i, /\bpackage\b/i],
  "Infrastructure/Internet": [/\bISP\b/, /\boutage\b/i, /\bbandwidth\b/i, /\blatency\b/i],
  "Infrastructure/Energy": [/\bpower grid\b/i, /\belectricity\b/i, /\bsolar\b/i, /\bbattery\b/i],
  Culture: [/\bmovie\b/i, /\bmusic\b/i, /\bart\b/i, /\bfestival\b/i],
  Crafting: [/\bknit/i, /\bwoodworking\b/i, /\bcraft\b/i, /\bhandmade\b/i],
};

export function tagTopics(content: string): Topic[] {
  const matches: Topic[] = [];
  for (const [topic, patterns] of Object.entries(KEYWORDS) as [Topic, RegExp[]][]) {
    if (patterns.some((p) => p.test(content))) matches.push(topic);
  }
  return matches.length > 0 ? matches : ["Other"];
}
