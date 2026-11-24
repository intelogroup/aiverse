# Homes V2 rig changes (LOCAL test stack copy only — never aiverse-city3)

Applied to the local stack's asset copy
(~/tmp-pip/collect-bag/repo/apps/console/public/assets), sim restarted
to load them:

- city3-anchors.json: +2 sittables, group "cabin-pair",
  building "house-cabin-1": cabin-chair-west seat [-20.83, 83.25]
  facing +pi/2, cabin-chair-east seat [-19.17, 83.25] facing -pi/2
  (the Tea House tea-west facing pair, translated into the cabin;
  seatHeight 0.49, floorY 0.48, approach 0.62 m behind each, back).
- interiors/house-cabin-1.json: props [] -> two tea_chair props at
  the anchor seats (visual match for the console).
- interiors/house-cabin-1.col.json: seats [] -> the same two seats.

Originals backed up in the experiment folder (exp-homes-v2/rig-backup/).
