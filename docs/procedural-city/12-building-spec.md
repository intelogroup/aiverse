# City 3 future building spec (2026-11-06)

Companion to 10-building-inventory.md (what exists) and 11-decor-probe-*.md (candidate assets, full tables). This is the target.

## Rules for every prop
- Free licence only. CC0 preferred; CC-BY allowed with an entry in ASSETS.md and out/asset-credits.json. No branded or trademarked designs (logos stripped).
- Budget: <=300 tris for repeated small items (bottles, jars), <=1k for furniture, hero pieces may go higher. Instance anything repeated (`inst_*` Empty, `export_gpu_instances=True`).
- Textures: base colour only, <=1k, per `assets_kit._diffuse_only`.
- Style test before rollout: one cafe test room, screenshot, then all 77 shops. Avramania low-poly vs Poly Haven realistic must not clash.
- Changing a seat or counter means updating `hero-anchors.json` and the nav seat anchors.

## Interior replacement plan (placeholder -> real prop)
| Placeholder (rooms.py) | Target | Licence |
|---|---|---|
| shelf_bottles_a/b/c (coloured boxes) | Split single bottles from Sketchfab "Alcohol bottles" (DaengNu) + Avramania Potion; CC0 option BlendSwap #33793; recolour per shelf | CC-BY / CC0 |
| shelf_goods_a/b | Poly Haven painted_wooden_shelves body + Avramania Sack, Roll, Basket, Pot | CC0 |
| sofa_3, booth | Poly Haven chinese_sofa; BlendSwap #30053 Diwan sofa (tea house); booth has no source yet | CC0 |
| armchair_blue/red | Poly Haven chinese_armchair | CC0 |
| rug_6x4, rug_4x3 | Avramania Rug or Persian Carpet | CC0 / CC-BY |
| fireplace | Sketchfab Fireplace Low-poly (MaX3Dd) or Poly Haven masonry heater | CC-BY / CC0 |
| frames_wall, menu_board | Poly Haven picture frames, standing_chalkboard_01, BlendKit Blackboard | CC0 |
| lanterns, tea tableware | Japanese Paper Lantern, chinese_tea_table, teapot | CC-BY / CC0 |
| counter, shop_counter, display tables, folded cloth | No source found: keep procedural or model by hand | - |
Avoid trademarked bottle packs (Absolut, Jack Daniels, Heineken, Coca-Cola).
Order: bottles -> furniture -> wall decor.

## Bazaar stalls (done 2026-11-06)
Goods live in `tools/city3/goods.py` (procedural pieces) and `goods_stock.py` (stock per stall + row layout). Counter geometry the layout assumes: procedural stall = counter top Z+1.0, 3.6 x 2.7 m,
awning front edge Z+2.35 at d=+1.9 (customer side, -y for facing S), hung goods at d=+1.55, top Z+2.375; village stall (`MEDSTALLS`) = counter top Z+1.164, +-1.15 m x +-0.6 m, rows d=-0.22 / +0.28, no hung goods.
Rules: new stock = add a piece to `goods.REG` and a branch to `goods_stock.layout`; keep the dedicated Random streams (5150+i, 6100+i, 5300); the old stall loop still *draws* its removed cuboids / sack blobs / price panel from the city rng so later layouts do not shift.

## Entrances
Geometry-only doors, 4-6 instanced styles (frame, leaf, handle, step, awning/lamp). Bazaar shops first, then Glass podiums, Foundry bays, Terraces gates, 11 grand Halo entrances. Doors do not open yet; `heroes.json` door positions must not move.

## Player and agent
- User-driven Summer bot (WASD, FPV + follow) in City 3, abstract intent input so an agent can drive it later.
- Agent-driven version needs City 3 navmesh/seat data (only footprints exist today).
- Driving vehicles: deferred; Halo ring road is the candidate district.

## Open
- Bazaar non-hero ~35 footprints: enterable or facade only (undecided).
- Cars: game-ready modulatable asset, CC-BY OK? generic vs brand? (parked).
- Retention lane (goal contracts, away digest, event-log replays) is a product spec, not a building spec: not included here.

- Foundry Wharf (2026-11-07, branch decor/foundry-industrial): loft door bays = 6 instanced roller doors (industrial.py, ~108-142 tris); containers v2 instanced (368 tris, ribs/castings/lock rods); loose props (pallets, loads, drums, PH barrel/crate, CC-BY forklift) in front of free bays, on the quay, in the yards and rail sidings, all with `props` collision. Still flat: boxcars (F3), yard grass (F7), quay maritime content (F6).
