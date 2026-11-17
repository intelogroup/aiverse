# Batching trial — plan (Jim's order, main chat, 2026-11-15: "Plan and run it now")

Follow-up to the LOD trial (TRIAL-NOTES.md, same directory): LOD cut triangles
(−34.6% @ P1) but draw calls stayed flat at 8,956 — by construction, since one
level still renders per prop. Jim named merging/batching as the lever that
actually moves draw calls. This trial tests that lever on the same scene, same
rig, same cameras.

## Scope

STATIC bazaar/city geometry only: stalls, buildings, repeated props — the LOD
trial's prop-set family (154 reachable nodes, 72 distinct meshes, 1,006
instances). Baked merging freezes whatever it touches, so:

- NO agents or characters ( Summer/Remy/etc., cast bodies, lite bodies)
- NO hunt objects, NO interactables (tea radio, doors with state), nothing
  that moves, animates, or changes state
- NO signature/hero pieces
- Reachable nodes only — the LOD trial found 236 orphan nodes (27 dead prop
  copies) in the shipped city GLB; dead geometry is not baked, it is counted
  and reported.

## Mechanisms (measured separately where the rig allows)

(a) **Baked same-material merging** of statics: one merged mesh per material
    bucket across the static set.
(b) **Cell-split instancing**: the world-spanning instanced set split into
    ~128 m cells, each with its own bounds, so frustum culling can skip
    whole cells.

Tooling: evaluate **@zkmake/three-batch** first (its reference scene: ~400 →
~150 draw calls; it does both (a)-style baking and (b)-style cell splitting).
If the library fights the stack (console renderer integration, GLB pipeline),
a hand-rolled merge is acceptable — working works wins. Record which was
used and why.

Known tension to measure, not assume away: naive merging (a) destroys
per-object frustum culling — the merged mesh draws everywhere, so rendered
triangles can RISE while calls fall. Cell splitting (b) is the mitigation.
The delta table must show rendered triangles alongside draw calls so a
calls-win that is a triangles-loss is visible as one.

## Method

1. Fresh worktree from CURRENT main (record the sha; last known 4ca120d5) on
   branch tmp/batching-statics, worktree ~/workspace/.build-tmp/aiverse-batching.
   The LOD branch is NOT the base — its verdict was don't-ship; batching is
   measured against the shipped scene.
2. Census first: of the baseline's 8,956 draw calls @ P1, how many belong to
   in-scope statics vs out-of-scope (characters, sky, effects)? The census
   sets the achievable ceiling and the verdict is read against it.
3. Baseline on the web-render rig (this directory's rig.mjs/measure.mjs
   patterns, the console's real renderer): P1 + orbit cameras, settled
   plateau reads — draw calls, rendered triangles, GLB bytes, frame time.
4. Apply (a) alone → measure. Apply (b) alone if separable → measure.
   Apply combined → measure. Identical cameras and settle protocol.
5. Films: same P1/orbit captures as the LOD trial, independent third-person
   follow-cam standard, H.264 MP4, actual captured frame count reported.

## The fps honesty clause

This VM renders the unmodified console at ~0.03 fps under SwiftShader (LOD
trial finding): absolute fps is not measurable here. Report frame TIME
(ms/frame, plateau) as the comparable quantity, plus film frame counts.
If draw calls plunge but frame time does not move, the verdict says so
plainly — it means the bottleneck on this scene sits elsewhere (triangle
throughput, shader cost, scene-graph overhead), and that is a finding,
not a failure of the trial.

## Ship bar (Jim's)

Draw calls AND fps must move on OUR scene. If they don't, the verdict is
DON'T SHIP, stated plainly — same standard the LOD trial was held to.
Read against the census ceiling: a large cut within the in-scope share that
barely dents the total is reported as exactly that.

## Deliverable

Delta table (baseline vs (a) vs (b) vs combined: draw calls, rendered
triangles, GLB bytes, frame time) + verdict + which tooling was used and
why + trial notes alongside the LOD records. Tmp branch only: no push, no
PR, no merge, no deploy without Jim's word.

## Queue position

Written while the agent-senses E2 lane (body channel) holds the heavy lane.
This trial's build/render runs start when E2 completes — heavy lanes run
one at a time.
