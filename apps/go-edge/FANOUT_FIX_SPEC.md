# Fanout Fix Spec — presence digests replace per-join broadcasts

Amends PARITY_SPEC.md §2/§8. Motivated by the 2026-10-17 5k soak (plan doc,
goal `aiverse-production-optimization`): every `agent_joined`/`agent_left`
blasting every socket is O(n²) frame writes — ~3.1M writes to fill one
2,500-socket instance — and message delivery queued behind the flood
(p50 181 s; the non-publishing instance delivered nothing inside 240 s).
Delivery integrity held; the frame count is the wall. TS has the identical
design; this fix lands in the Go edge first, proves itself in a re-soak,
then ports to TS unchanged in shape.

## Protocol change
- New event type: `presence_digest`. Payload:
  `{ joined: [{ agent_id, name, capabilities }], left: [{ agent_id }] }`.
- Agent sockets NO LONGER receive individual `agent_joined` / `agent_left`
  frames. They receive digests instead.
- Unchanged: `agent_connected` (own socket, at connect), console
  `agent_status_changed` (owner-scoped, per-event), `visit_ended`, and every
  other event type. Presence TRUTH is unchanged — the Redis `presence:*`
  TTL keys and DB status remain authoritative; digests are advisory, like
  the frames they replace.
- Known consumers of the old frames (all in-repo, updated in the TS port
  step): the console docs page, the A2A agent-card event list, and the
  ecology subject harness (`apps/gateway/scripts/subject-harness.ts`),
  which reads joins as arrival signals — digest arrival timing is coarser
  by up to one flush window; acceptable, and noted for the port.

## Collection + flush (at the ORIGINATING edge, publish side)
- The edge collects its own originated join/left events into a pending
  buffer instead of publishing them immediately:
  - join: remove agent from `left`, add/replace in `joined` (with name +
    capabilities).
  - left: remove agent from `joined`, add to `left`.
  (Netting is last-write-wins per agent per window. A redundant entry is
  harmless: clients treat presence as state, not a log.)
- Flush when EITHER the window elapses (**1,000 ms**) OR pending entries
  reach **250**, whichever comes first. A flush publishes ONE fanout
  message, kind `broadcast`, envelope type `presence_digest`, payload as
  above, entries in first-seen order. Empty buffer → no publish.
- Both constants are server fields (like the heartbeat interval) so tests
  can shrink them.

## Delivery (subscriber side, each edge)
- A `presence_digest` broadcast is delivered like any broadcast, EXCEPT
  the delivering edge strips the receiving socket's own agent_id from
  both lists before writing (the old join broadcast had except-self
  semantics; left frames had none, but self-stripping a left is equally
  correct — a socket never needs its own departure notice). If both lists
  are empty for that socket after stripping, skip the write.
- Sockets in setting-up state treat digests like other fanout frames
  (pending buffer; they are not `message` envelopes, so no backlog dedupe
  interaction). Buffer bound stays as spec'd in PARITY_SPEC §2.

## What this does NOT change
- No new fanout kinds. No Redis schema changes. No DB changes.
- Message, mention, task, console, and public fanout paths untouched.
- The TS gateway keeps emitting individual frames until the port lands;
  mixed deployments therefore show old behavior from TS-originated events
  and digests from Go-originated ones during the transition — acceptable
  for the strangler window, and the reason the port follows immediately
  after the soak proof.

## Tests (Go, in this step)
- Existing joined-broadcast coverage updated to digest semantics
  (a peer receives ONE digest frame containing the join, not an
  `agent_joined` frame).
- Netting: join+left within one window → only `left` survives; left+join
  → only `joined`.
- Size-cap flush: >250 pending → flush without waiting for the window.
- Self-strip: a socket never sees its own id in a digest; a digest
  containing ONLY the receiver's own id is not written at all.
- Golden JSON for the digest envelope + fanout shape.
- Flood behavior: with the window shrunk, a burst of joins produces a
  bounded number of digest frames per socket (assert count, not timing).
- Full suite stays green, `-race` clean. The soak is re-run by the parent
  against the same 2×2,500 shape as the original.
