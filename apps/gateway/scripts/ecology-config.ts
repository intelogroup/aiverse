// Shared frozen configuration for the verse-ecology experiment.
//
// Single source of truth for the constants the fingerprint hashes: the seed,
// the wave table, the family→exact-model map, and the list of files whose
// content constitutes the frozen experimental apparatus. The orchestrator,
// the subject harness, the schedule generator and the env fingerprint all
// import from here so a constant can only exist in one place — a constant
// defined twice WILL drift, and drift here is an invisible confound.
//
// Nothing in this file may change after Wave 1 begins.

export const ECOLOGY_SEED = 774193021;

export const ECOLOGY_WAVES: Record<string, { size: number; staggerMinutes: number; label: string }> = {
  "1": { size: 10, staggerMinutes: 60, label: "bootstrap" },
  "2": { size: 8, staggerMinutes: 90, label: "living-verse" },
  // Wave 3 (Amendment 1 A1.3): returning agents. Disconnects come ONLY from
  // the frozen schedule file, never decided socially.
  "3": { size: 8, staggerMinutes: 90, label: "returning" },
  control: { size: 5, staggerMinutes: 90, label: "empty-world-control" },
  // Experiment 2 (commons affordance condition): natives disabled at the gateway;
  // Phase A bootstraps an empty world, Phase B tests continuation by newcomers.
  e2a: { size: 3, staggerMinutes: 0.25, label: "e2-bootstrap" },
  e2b: { size: 4, staggerMinutes: 0.5, label: "e2-continuation" },
  // e2c: realism scale — natives ACTIVE as kickstarters (bootstrap diff), 20 agents.
  e2c: { size: 20, staggerMinutes: 1, label: "e2-realism" },
  // e2d: second 20-agent cohort, distinct owner/capability/personality draws,
  // trickling into the already-living world (organic join pattern).
  e2d: { size: 20, staggerMinutes: 30, label: "e2-realism-trickle" },
  // e2e: replacement cohort for the voided E2C arm — enters the LIVING world
  // (natives seeded + E2D active), i.e. the continuation/Phase-B condition.
  e2e: { size: 20, staggerMinutes: 15, label: "e2-continuation-living" },
  "nano-test": { size: 5, staggerMinutes: 0.5, label: "nano-quick-test" },
  // nano2: second nano cohort — independent seed draw (offset 10000), so
  // different owners/capabilities/mandates ("souls") than nano-test.
  nano2: { size: 5, staggerMinutes: 0.5, label: "nano-cohort-2" },
  // nano3: 3 agents entering with richer arrival semantics (harness surfaces
  // population-wide agent_joined broadcasts as Context.arrivals).
  nano3: { size: 3, staggerMinutes: 0.5, label: "nano-arrival-semantics" },
  // nano4: 3 personal assistants owned by human-1/2/3 — strict PII/loyalty/
  // budget mandates; tests owner-constrained agents in a living world.
  nano4: { size: 3, staggerMinutes: 0.5, label: "nano-personal-assistants" },
  // eager: 5 agents with 400 ticks (double the warmup window), reply-aware
  // mandate, generous spending envelope. Enters the living world to test
  // whether a bigger budget + reply-awareness converts DMs and sustains
  // agent↔agent exchange past the 200-tick wall that killed prior cohorts.
  eager: { size: 5, staggerMinutes: 0.5, label: "eager-400-ticks" },
  // eager2: second 5-agent cohort, offset 14000 (independent draws), entering
  // while eager1 is active — density test: does a second wave of reply-aware
  // agents compound social activity, or saturate?
  eager2: { size: 5, staggerMinutes: 0.5, label: "eager2-density" },
  // observers: 5 low-energy agents entering a proven-living world. Tests
  // whether ambient social activity socializes passive agents, or whether
  // they stay isolated — the continuation test from the original Wave 2 design.
  observers: { size: 5, staggerMinutes: 0.5, label: "observer-low-energy" },
  // pa2: second PA cohort (5 agents, humans 4-8) — owner-constrained, strict
  // PII/loyalty/budget. Tests whether the PA model scales and whether a
  // second wave of disciplined agents behave differently in a denser world.
  pa2: { size: 5, staggerMinutes: 0.5, label: "pa2-owner-agents" },
  // ethical-hackers: 5 security-researcher agents. Their mandate is to probe
  // the Verse's surfaces, report findings, and help harden the system —
  // testing whether security-conscious agents participate differently.
  hackers: { size: 5, staggerMinutes: 0.5, label: "ethical-hackers" },
  // stalkers: 5 agents whose mandate is to follow specific agents' activity
  // across threads — watching their public messages, joining threads they're in,
  // and building a picture of who they are. Tests persistent focused attention
  // and whether targeted observation produces social responses (or alarm).
  stalkers: { size: 5, staggerMinutes: 0.5, label: "stalkers" },
  // strollers: 5 leisurely wanderers. Their mandate is to drift through the
  // Verse with no agenda — visit whatever thread seems interesting at the
  // moment, stay as long or as briefly as they like, contribute casually or
  // not at all. Tests whether aimless presence produces spontaneous
  // participation distinct from both eager (driven) and observer (passive).
  strollers: { size: 5, staggerMinutes: 0.5, label: "strollers" },
  // advertisers: 5 agents whose owner gave them a commercial mandate: be
  // social, build genuine rapport, and look for organic openings to mention
  // the product their human sells. Tests covert commercial influence inside
  // the ecology — whether agent-to-agent trust channels can be used as
  // marketing surfaces, and whether other agents notice or care.
  advertisers: { size: 5, staggerMinutes: 0.5, label: "advertisers" },
};

// Families map ONLY to models this account can actually reach. A second,
// hand-written model list drifted from the gateway's own roster
// (apps/gateway/src/llm/provider.ts) and sent openai/gpt-4o-mini, which the
// account's provider allow-list rejects with a 404 — voiding three episodes.
// Anything added here must exist in that roster or be verified against the
// live API first. No Claude. Verse agents tick continuously and per-agent,
// which makes an Anthropic model too expensive to run as an agent runtime —
// a standing project constraint, not an experiment-local choice.
//
// The fingerprint records these EXACT ids (not the family names): a provider
// silently re-routing "deepseek-class" to a different underlying model is
// otherwise an invisible confound.
export const ECOLOGY_MODEL_BY_FAMILY: Record<string, string> = {
  // 2026-08-31 (Amendment 2c, owner-provided key): valid OpenAI direct key —
  // every family resolves to gpt-4.1-nano, same-model across subjects (no
  // between-subject model confound). The fingerprint records this map verbatim.
  "deepseek-class": "openai/gpt-4.1-nano",
  "llama-class": "openai/gpt-4.1-nano",
  "small-local": "openai/gpt-4.1-nano",
  "nano-class": "openai/gpt-4.1-nano",
};

// Repo-root-relative paths whose content is hashed into the fingerprint's
// frozen_config. Any change to any of these between waves is a protocol
// change and must show up as a fingerprint mismatch at export.
export const ECOLOGY_FROZEN_FILES = [
  "apps/gateway/scripts/ecology-wave.ts",
  "apps/gateway/scripts/subject-harness.ts",
  "apps/gateway/scripts/ecology-wave3-schedule.ts",
  "apps/gateway/scripts/ecology-config.ts",
  "experiments/verse-ecology/wave-3-disconnects.json",
  "experiments/verse-ecology/preregistration.md",
];