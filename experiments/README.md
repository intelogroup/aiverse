# Experiments — index

Written 2026-11-17 (cleanup lane L1) so nobody has to guess what in
here is evidence and what is scaffolding. Nothing in this directory is
deployed, and no runtime code in `apps/` or `packages/` imports from
it. One designed coupling exists: the gateway's ecology driver scripts
(`apps/gateway/scripts/`) read and write `experiments/verse-ecology/`
(preregistration, run logs) — that is part of the sealed record's own
tooling, not an accident.

**Classes**

- **Sealed record** — the frozen evidence base of a finished research
  program. Do not edit, move, or delete; findings in `AGENTS.md` cite
  it as sealed.
- **Session record** — the preserved record of a single live session,
  kept under the same hands-off rule as a sealed record.
- **One-off** — a proof harness, probe, or investigation that served
  its run and was kept as a record. Not load-bearing; nothing imports
  it.

Moving or archiving any directory here is a separate, per-directory
decision (cleanup plan L3) — never piecemeal, never as a side effect
of another change.

| Directory | Class | Files | Last commit | Note |
|---|---|---|---|---|
| `verse-ecology/` | Sealed record | 320 | 2026-09-23 | Sept-2026 ecology program: preregistration, waves, findings. Referenced by `apps/gateway/scripts/` ecology drivers |
| `social15-session1/` | Session record | 91 | 2026-11-12 | Social15 session 1 record (PR #137 pattern) |
| `renderer-tests/` | One-off | 41 | 2026-11-13 | Renderer proof harness |
| `decision-head/` | One-off | 31 | 2026-11-09 | Decision-head investigation |
| `body-proofs/` | One-off | 24 | 2026-11-12 | Body/embodiment proofs |
| `border/` | One-off | 23 | 2026-11-09 | Border probe; carries 1 test file. The console sensorium suite's surface enumerator references it |
| `look-service/` | One-off | 21 | 2026-11-13 | Look service record (PR #90) |
| `gauntlet/` | One-off | 13 | 2026-11-09 | Gauntlet runs |
| `drive-layer/` | One-off | 12 | 2026-11-09 | Drive-layer probe |
| `bazaar/` | One-off | 9 | 2026-10-02 | Bazaar experiment scaffolding (the bazaar *route* in the gateway is separate code, mounted conditionally — not part of this directory) |
| `cold-agents/` | One-off | 6 | 2026-11-10 | Cold-agent probes |
| `cold-claude/` | One-off | 6 | 2026-11-11 | Cold Claude probes |
| `checkpoint/` | One-off | 4 | 2026-11-09 | Checkpoint probe |
| `native-ambient-utility/` | One-off | 1 | 2026-08-28 | Native ambient utility note |
| `SESSION-2026-11-09.md` | Session note | 1 | 2026-11-09 | Session log, kept with the records it describes |
