# Free assets: sources, licences, recipes (checked 2026-11-06)

| Source | Licence | Reachable | Notes |
|---|---|---|---|
| **Poly Haven** models/textures/HDRIs | CC0. No attribution needed; the *live API* asks for a small "Powered by Poly Haven" credit | yes (`api.polyhaven.com`, `dl.polyhaven.org`, UA header required) | 521 models (85 furniture, 26 structures, 20 trees…). `GET /assets?t=models`, `GET /files/<id>` → `gltf/{1k,2k,4k}/gltf` with `include` map of textures + md5. Some models have no glTF (`decorative_book_set_01`). Also textures (`t=textures`) and HDRIs (`t=hdris`) — useful for facades/skies |
| **Quaternius** | CC0 | site yes; packs mostly on Google Drive (302, not followed). The "Furniture Pack" mirrors on **OpenGameArt** (`opengameart.org/sites/default/files/Furniture%20Pack%20by%20%40Quaternius.zip`) | OBJ/FBX are flat grey; colours only in .blend → recolour by slot name (`assets_kit._recolor`) |
| **Kenney** | CC0 | **blocked (403)** | itch.io mirrors untested |
| **Poly Pizza** | per-model | **blocked (403)** | |
| **BlenderKit** | "Royalty Free" (not extractable in a shipped game) or CC0 | needs account/add-on | its FAQ says assets in a distributed game "shouldn't be directly extractable"; a web GLB is extractable → CC0 items only |
| **Synty POLYGON** | paid EULA | page only | unclear for raw models in a browser build; don't use without reading the One-Time-Purchase licence |
| **OpenGameArt** | per item (many CC0) | yes | check each listing's licence |

Credits live in `tools/city3/ASSETS.md` (+ `out/asset-credits.json`). Assets are *not* committed; `tools/city3/assets/fetch.sh` re-downloads them.

## Recipes
- Poly Haven model: fetch `files/<id>` → download gltf + `include` files into `assets/polyhaven/<id>/` (md5 check) → `assets_kit.load(id, budget_tris, tex=px)`.
- Poly Haven **texture** (PBR facade/ground): `files/<id>` → `Diffuse/1k/jpg`; for the city use base-colour only, tile in UV metres.
- Budgets that worked: furniture 1.5–4k tris, textures 128–512 px, whole library 2.4 MB / 45 assets.
