// asset-budgets.ts — per-district world-asset budgets (the gate).
//
// WHY THIS FILE EXISTS
// The world grows by content PRs, and content PRs used to land unpriced:
// PR #146 (Tea House interiors) grew world-city3.glb by +12% in a single
// merge and nobody saw a number. This table is the price tag. The test in
// asset-budget.test.ts measures every district GLB named by
// public/assets/districts.json and fails CI when a district crosses its
// budget — so a content PR that busts one has to argue with a number in
// the open, in its own PR, instead of the world silently outgrowing what
// a phone browser can load live.
//
// HOW BUDGETS MOVE
// Budgets change ONLY by a deliberate PR that edits this file (the same
// PR that busts a budget may raise it — with the justification in the PR
// body). Never widen a budget inside an unrelated change, and never
// "fix" a red gate by editing the measured column: `measured` records
// what the world actually weighed when the budget was set, and the
// failure message prints the growth since then.
//
// SET 2026-11-12 against main 2d1de52599. Multipliers over the
// measured values: the spawn district (bazaar) ×1.15 bytes — tightest,
// because it is the first-load every visitor pays; other districts
// ×1.25 bytes; triangles ×1.20 everywhere; the districts total (all
// GLB + collision bytes) ×1.20.
//
// RE-BASE NOTE (same day): this table was first measured against main
// b587ad4952, where bazaar weighed 37,250,236 B / 728,786 triangles.
// While this PR was in preparation, PR #149 (Bazaar interiors +
// open-space pass) landed and rebuilt world-city3.glb at 87,289,408 B
// / 1,578,712 triangles (+134% bytes in one merge — the exact failure
// mode this gate exists to price). The bazaar row and the total were
// re-measured on the new main and re-based with the SAME multipliers;
// all other districts were verified byte-identical between the two
// mains (git blob SHAs) and keep their original set-points. The #149
// growth itself is called out in this PR's body for a human ruling —
// the gate installs discipline from today's ground, it does not
// retroactively bless or block a merge that already landed.
//
// DOUBLED 2026-11-23 (deliberate, by the owner): every cap below was raised
// x2 (bazaar GLB 100.4 -> 200.8 MB, collision 10.0 -> 20.0 MB, triangles
// 1.89 -> 3.79 M, districts total 160.9 -> 321.9 MB) so the City 3 rebuild
// (real buildings from free kits, far more polygons) is not strangled by
// numbers set when the world was boxes. `measured` is unchanged on purpose.
// The far-view cap (MAX_BYTES in tools/city3/split_lod.mjs) went 5 -> 10 MB.
//
// GATED metrics are exact: file bytes and triangle counts (accessor
// counts). Estimated texture VRAM is printed in the test's summary
// table but is NOT gated — the estimate (KTX2 uncompressed level sizes;
// RGBA8 + mip chain for PNG/JPEG) is method-dependent, so it informs
// reviews without pretending to be a GPU measurement.

export interface DistrictBudget {
  /** What the district weighed when this budget was set (2026-11-12). */
  measured: { glbBytes: number; collisionBytes: number; triangles: number };
  /** The gate. Current values must stay at or below these. */
  budget: { glbBytes: number; collisionBytes: number; triangles: number };
}

export const DISTRICT_BUDGETS: Record<string, DistrictBudget> = {
  bazaar: {
    measured: { glbBytes: 87_289_408, collisionBytes: 8_684_616, triangles: 1_578_712 },
    budget: { glbBytes: 200_765_640, collisionBytes: 19_974_618, triangles: 3_788_910 },
  },
  // Placed prebuilt houses (tools/city3/houses.sh -> place_house.mjs --asset), one entry per shared GLB however many lots use it, x1.25 headroom.
  // High-poly on purpose (user, 2026-11-23); textures capped at 2048 px by slim_textures.py.
  "/assets/houses/american-y0.glb": {
    measured: { glbBytes: 9_607_572, collisionBytes: 1_032, triangles: 41_990 },
    budget: { glbBytes: 12_009_465, collisionBytes: 2_000, triangles: 52_487 },
  },
  "/assets/houses/cabin-y0.glb": {
    measured: { glbBytes: 65_265_244, collisionBytes: 7_104, triangles: 1_269_815 },
    budget: { glbBytes: 81_581_555, collisionBytes: 9_945, triangles: 1_587_268 },
  },
  "/assets/houses/villa-pool-y0.glb": {
    measured: { glbBytes: 6_436_880, collisionBytes: 1_040, triangles: 133_529 },
    budget: { glbBytes: 8_046_100, collisionBytes: 2_000, triangles: 166_911 },
  },
  "/assets/houses/mayflower-y90.glb": {
    measured: { glbBytes: 4_748_568, collisionBytes: 1_036, triangles: 26_821 },
    budget: { glbBytes: 5_935_710, collisionBytes: 2_000, triangles: 33_526 },
  },
  "/assets/houses/shirakawago-y0.glb": {
    measured: { glbBytes: 8_033_036, collisionBytes: 1_036, triangles: 31_838 },
    budget: { glbBytes: 10_041_295, collisionBytes: 2_000, triangles: 39_797 },
  },
  "/assets/houses/zen-pavilion-y270.glb": {
    measured: { glbBytes: 2_013_560, collisionBytes: 7_224, triangles: 20_763 },
    budget: { glbBytes: 2_516_950, collisionBytes: 10_113, triangles: 25_953 },
  },
};

/** All districts' GLB + collision bytes combined, gated at ×2.40 of
 * the 134,108,292 measured on 2026-11-12 (after the PR #149 re-base
 * noted above; it was 84,048,576 before #149). */
export const DISTRICT_TOTAL_BUDGET = {
  measuredBytes: 134_108_292,
  budgetBytes: 321_859_902,
};
