# Mira — uploaded Tea House resident

Mira is the user's `Female+Maid+Facesless.zip` model. The archive contains one static OBJ/MTL and four 4096 px PBR maps. There is no armature, animation or included licence document; this is a local resident, not a registered backend agent.

The browser copy is 30,000 triangles (source: 500,000), 1.68 m tall, with 1024 px base colour, normal and metallic/roughness maps. Feet are normalized to local y=0. Original files stay outside public assets and Git; provenance, checksums and preparation details are in `tools/city3/assets/mira_maid.json`.

`MiraResident.tsx` places her at `[-26.6, .2, -70.4]` on the paving outside the Tea House, left of its door and beside the existing planter. The model loads within 45 m of the camera and has a closed furniture-style collision box. **Meet Mira** in the desktop City 3 places bar frames her. She carries no floating nameplate: Jim's 2026-11-08 order deleted every floating name label, so the plate this change originally shipped with was dropped when it was rebased onto that deletion (PR #56). The OBJ source is static, so there are no idle/walk clips to play.

Keep Blender calls serialized through `blender_lock.sh`. Inspect close and full-body views, check both feet on the paving, and test the Tea House doorway remains clear before changing this placement.

## Verification and placement lessons

- Browser inspection: one mesh, 30,000 triangles, world bounds y=0.20017–1.88004 m; the ground query at her feet returns y=0.2. The GLB has three embedded images and no external texture URLs or animation clips.
- A forward walk from the street stops at z=-69.73 before reaching her z=-70.4 collider. Browser checks report no JavaScript errors.
- The first placement at x=-25, z=-70.8 intersected a planter, and a 180° turn showed the back of the model. The final position is clear of the planter and faces the street at yaw=0. Verify the pixels even when the numerical floor height is correct.
- The model enters at 45 m and stays resident until 55 m to avoid boundary churn. An HTML nameplate was tried during development (screen-sized, after a world-scaled label proved much too large in close views) but was removed before merge per the no-floating-labels order; the **Meet Mira** places-bar framing is her identifier.
