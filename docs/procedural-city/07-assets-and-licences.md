# Free assets: sources, licences, recipes (checked 2026-11-06)

| Source | Licence | Reachable | Notes |
|---|---|---|---|
| **Poly Haven** models/textures/HDRIs | CC0. No attribution needed; the *live API* asks for a small "Powered by Poly Haven" credit | yes (`api.polyhaven.com`, `dl.polyhaven.org`, UA header required) | 521 models (85 furniture, 26 structures, 20 trees…). `GET /assets?t=models`, `GET /files/<id>` → `gltf/{1k,2k,4k}/gltf` with `include` map of textures + md5. Some models have no glTF (`decorative_book_set_01`). Also textures (`t=textures`) and HDRIs (`t=hdris`) — useful for facades/skies |
| **Quaternius** | CC0 | site yes; packs mostly on Google Drive (302, not followed). The "Furniture Pack" mirrors on **OpenGameArt** (`opengameart.org/sites/default/files/Furniture%20Pack%20by%20%40Quaternius.zip`) | OBJ/FBX are flat grey; colours only in .blend → recolour by slot name (`assets_kit._recolor`) |
| **Kenney** | CC0 | **blocked (403)** | itch.io mirrors untested |
| **Poly Pizza** | per-model | **blocked (403)** | |
| **BlenderKit** | "Royalty Free" (not extractable in a shipped game) or CC0 | REST API works (see Halo section, `02-environment.md`) | its FAQ says assets in a distributed game "shouldn't be directly extractable"; a web GLB is extractable → CC0 items only |
| **Synty POLYGON** | paid EULA | page only | unclear for raw models in a browser build; don't use without reading the One-Time-Purchase licence |
| **OpenGameArt** | per item (many CC0) | yes | check each listing's licence |

Credits live in `tools/city3/ASSETS.md` (+ `out/asset-credits.json`). Assets are *not* committed; `tools/city3/assets/fetch.sh` re-downloads them.

## Recipes
- Poly Haven model: fetch `files/<id>` → download gltf + `include` files into `assets/polyhaven/<id>/` (md5 check) → `assets_kit.load(id, budget_tris, tex=px)`.
- Poly Haven **texture** (PBR facade/ground): `files/<id>` → `Diffuse/1k/jpg`; for the city use base-colour only, tile in UV metres.
- Budgets that worked: furniture 1.5–4k tris, textures 128–512 px, whole library 2.4 MB / 45 assets.

## Sketchfab (added 2026-11-06)
API works with a user token (`SKETCHFAB_TOKEN` env var; never commit it). Search: `/v3/search?type=models&downloadable=true&licenses=cc0&q=...&max_face_count=...`
(the filter is `licenses=<slug>`, not `license=`). `assets/fetch_sketchfab.py name=uid ...` skips anything not CC0 and writes `meta.json` credit.
Used: Low Poly Medieval CC0 lantern/pot/produce crate, baked into the Bazaar stalls as linked duplicates (`assets_kit.load(source="sketchfab")`).

## Poliigon: NOT usable in shipped output (decision 2026-11-06)
Poliigon's licence (help.poliigon.com/en/articles/8749749) allows free assets on commercial projects but forbids redistribution, explicitly
"baking textures or embedding models and textures". Our GLBs are public downloads, so no Poliigon asset may be baked into them or committed.
Removed from the build; counters now use Poly Haven CC0 (CashRegister_01, ceramic_pot, metal_jug, brass_goblets). Poliigon is fine for private
offline renders only. The earlier commit 9d61a42..(this branch) still holds the old library GLB in git history.

## Sketchfab search notes
Search needs no token. Result `license` is `{uid,label}` (no slug) - match "CC0" in the label. Server `licenses=cc0` works but CC0 downloadable
low-poly street props are scarce (mostly museum scans); useful hit: "Low Poly Medieval, CC0" pack (bench, stall, crates; fetched to assets/sketchfab/med_*).
`max_face_count` server filter returned nothing - filter `faceCount` client-side. Download API needs a token (personal token via env var only).

## Bazaar: Sketchfab "Low Poly Medieval, CC0" props (2026-11-06)
Fountain-ring and plaza-rim benches are now `med_bench` (616 tris, backrest on +y in Blender axes, rotate -90 deg for the other axis) and ~60% of stalls get a `med_crate`
(`build_city.py`, `BENCHES` list + `_skput`). Street-front benches along facades stay procedural. Seen in screenshots: benches read well, backrests face outward from the fountain.
Village stall (`med_stall`, 752 tris): ~35% of the 80 stalls (`MEDSTALLS`, seeded per stall index) use it instead of the procedural stall, scaled (1.4, 1.4, 1.2); the
scalloped awning edge is its -y side (rot 0 for facing S, pi for N). Verified from the plaza side for S-facing stalls; N-facing orientation not yet checked in a screenshot.

## Agora 2 spike sources (2026-11-06, not shipped)
- Quaternius Modular Sci-Fi MegaKit Standard (CC0, 190 glTF): itch.io `POST <page>/download_url` -> download page -> `POST <page>/file/<upload_id>?source=game_download` (60 s signed URL).
- Kenney Modular Space Kit (CC0): direct zip on OpenGameArt (`kenney_modular-space-kit_1.0.zip`).
- BlenderKit: API search works without a key. Free assets are mostly **royalty-free, not CC0**; FAQ allows them in games only "if the models can't be extracted easily" -> a public web GLB is easy to extract -> excluded (same reasoning as Poliigon). CC0 BlenderKit assets only.
- BlendSwap MCP: CC0 filter works, licences are uploader-declared; useful hits: Round Robot (rigged), Low Poly Rock Formation #2, Beach Cliff scan.

## Halo Lagoon sources (2026-11-06)
- **BlenderKit CC0 works end-to-end** (recipe in `02-environment.md`): downloaded "Blue Striped beach chair" glb (`assets/blendkit/beach_chair/`).
  Branded cars (Ferrari/BMW etc.) are CC0-tagged but avoid them (trademarks); generic "car" is batmobile-styled -> skipped.
- **BlendSwap CC0** (`assets/blendswap/`): #20393 "Tropical Palm Tree (Cycles)" by TheMav — 37k tris of geometric leaves; decimating to game budget shreds the
  fronds -> not used as mesh. #5812 "Palm Tree Cycles Ready" by SSimpossible — `PalmFrondDiffuse.png`/`PalmFrondAlpha.png` alpha-masked frond texture -> used on
  procedural alpha-card fronds.
- **Sketchfab** CC0 searches for palm/tropical/plant/bush/parasol/car/yacht return almost only museum scans -> not useful.
- **Poly Haven** fetched: models outdoor_table_chair_set_01, bronze_whale_statue, bronze_ray_statue, bronze_shark_statue, CoffeeCart_01, planter_box_01,
  potted_plant_04, lifebuoy; texture palm_tree_bark.
