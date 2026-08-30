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
  "deepseek-class": "deepseek/deepseek-v4-flash",
  "llama-class": "meta-llama/llama-3.1-8b-instruct",
  "small-local": "google/gemini-2.5-flash-lite",
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