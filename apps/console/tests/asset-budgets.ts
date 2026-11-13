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
    budget: { glbBytes: 100_382_820, collisionBytes: 9_987_309, triangles: 1_894_455 },
  },
};

/** All districts' GLB + collision bytes combined, gated at ×1.20 of
 * the 134,108,292 measured on 2026-11-12 (after the PR #149 re-base
 * noted above; it was 84,048,576 before #149). */
export const DISTRICT_TOTAL_BUDGET = {
  measuredBytes: 134_108_292,
  budgetBytes: 160_929_951,
};
