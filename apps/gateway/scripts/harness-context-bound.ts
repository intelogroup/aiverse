// Bounded model context for the subject harness.
//
// Wave mp-ladder (2026-09-08, VOIDED) established the failure mode: the model
// context's aggregate size grows with the run (open_dm_by_participant reaches
// 250+ entries over 400 ticks; peers roster, public_activity, memory_notes all
// accumulate), and gpt-oss-20b via OpenRouter rejects prompts above 4280
// tokens. From tick ~332 every agent starved on 402 "Prompt tokens limit
// exceeded: 9934 > 4280" — the last ~70 ticks of all 10 decision logs are
// null-action rows, voiding the run.
//
// boundModelContext() enforces a hard budget on the serialized user context,
// trimming the biggest contributors first. It is measurement plumbing, NOT
// conduct: it never adds instructions, ranks peers, or changes what the agent
// is told — and it applies IDENTICALLY to both mp-ladder arms (the mandate
// text is the only manipulated variable). What it does change is the
// guarantee that tick 400's decision is as real as tick 5's.

// Prompt budget for the user context alone. Ceiling math: gpt-oss-20b prompt
// limit 4280 tokens; system prompt + ACTION_GRAMMAR ~1100-1400; completion
// max_tokens 900 is separate. 2200 leaves >700 tokens of headroom against the
// crude chars/4 estimate (JSON overhead inflates the real count, so err low).
export const CONTEXT_TOKEN_BUDGET = 2200;

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function boundModelContext<T extends Record<string, any>>(ctx: T): { bounded: T; trims: string[] } {
  const out: any = { ...ctx };
  const trims: string[] = [];
  const overBudget = () => estimateTokens(JSON.stringify(out)) > CONTEXT_TOKEN_BUDGET;

  // Progressive caps, biggest contributors first. Each step is a fixed,
  // deterministic slice (no semantic selection), so both arms see the same
  // transformation of the same context shape.
  const steps: Array<[string, () => void]> = [
    // Pure dedup: the tick loop sets modelContext.conversations = ctx.inbox_focus
    // but keeps BOTH fields, so the focused threads serialize twice (3758 of
    // 4387 tokens in the voided run's shape). The model reads conversations;
    // inbox_summary + inbox_note already describe the triage.
    ["inbox_focus:deduped", () => {
      if (out.inbox_focus !== undefined && out.inbox_focus === out.conversations) delete out.inbox_focus;
    }],
    // 250+ DM entries at 400 ticks — the dominant grower.
    ["open_dm_by_participant:40", () => {
      const keys = Object.keys(out.open_dm_by_participant ?? {});
      if (keys.length > 40) out.open_dm_by_participant = Object.fromEntries(keys.slice(0, 40).map((k) => [k, out.open_dm_by_participant[k]]));
    }],
    ["peers:40", () => {
      if ((out.peers?.length ?? 0) > 40) out.peers = out.peers.slice(0, 40);
    }],
    ["public_activity:12", () => {
      if ((out.public_activity?.length ?? 0) > 12) out.public_activity = out.public_activity.slice(0, 12);
    }],
    ["memory_notes:1200chars", () => {
      if ((out.memory_notes ?? "").length > 1200) out.memory_notes = out.memory_notes.slice(0, 1200);
    }],
    ["arrivals:10", () => {
      if ((out.arrivals?.length ?? 0) > 10) out.arrivals = out.arrivals.slice(0, 10);
    }],
    // Thread depth: last-4 already applied upstream; last-2 is the fail-safe.
    ["thread_messages:2", () => {
      for (const t of out.conversations ?? []) t.messages = (t.messages ?? []).slice(-2);
    }],
    // Thread count: keep the focused inbox order (invested first, newest
    // inbound next) — the same order triageThreads already chose.
    ["focused_threads:8", () => {
      if ((out.conversations?.length ?? 0) > 8) out.conversations = out.conversations.slice(0, 8);
    }],
    ["focused_threads:4", () => {
      if ((out.conversations?.length ?? 0) > 4) out.conversations = out.conversations.slice(0, 4);
    }],
    ["mentions_of_me:3", () => {
      if ((out.mentions_of_me?.length ?? 0) > 3) out.mentions_of_me = out.mentions_of_me.slice(0, 3);
    }],
  ];

  for (const [label, apply] of steps) {
    if (!overBudget()) break;
    apply();
    trims.push(label);
  }

  // Absolute fail-safe: if even the fully-trimmed shape is over budget
  // (pathological content, e.g. a peer roster of 1000 with 40 still huge),
  // drop the two heaviest remaining blocks entirely. Ground-truth fields the
  // grammar needs (known_room_slugs, already_joined_rooms, mentions_of_me,
  // open_dm_by_participant) survive all of this — they are small and
  // decision-critical, which is exactly why they are trimmed LAST, if ever.
  if (overBudget()) {
    delete out.peers;
    trims.push("peers:dropped");
  }
  if (overBudget()) {
    delete out.public_activity;
    trims.push("public_activity:dropped");
  }

  return { bounded: out as T, trims };
}