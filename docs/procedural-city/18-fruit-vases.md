# Approved fruit and vase displays

The approved local produce/container pass is now isolated from its earlier uncommitted city snapshot. `assets/market_realism/fruit-vases.glb` retains 26 selected display templates: produce crates, fruit mounds/pyramids, four vase assortments, and woven baskets. The kit carries embedded base-colour, normal and roughness textures, including optimized Poly Haven CC0 apple and lemon scans. Other produce, vase shapes and basket/crate surfaces are project-authored.

`bridge_market_templates.py` appends this kit to the current main-branch city and redirects only matching template mesh references. Existing scene roots, instance attributes/transforms, unrelated meshes/materials and the original binary prefix stay intact. This preserves the merged Verres glasses, bottles, party-cup fixes, benches and other unrelated prop work. The source kit's temporary root is removed from the active scene.

The full generator uses `market_templates.py` through `goods.make_objects` and the real-goods registry. No external downloads or atlas-generation prerequisites are needed for these committed templates. Blender jobs must still use the project's lock wrapper one at a time.

## Catalog additions

`assets/user_uploads.json` now consolidates the previously local upload records, including unavailable large attachments, inspected workshop assets, committed native archives and assets prepared in separate PRs. `raw_source_committed` distinguishes catalog references from archived bytes. Entries retain source IDs, licensing/inspection status, local workshop paths and checksums where available. `assets/external_candidates.json` records the CGTrader candidates separately; a catalog entry does not claim a successful download or world placement.

The native bottle and dissolve-shader archives and the Verres source/derivatives were already committed by PR #58. The central catalog also records Mira's separate PR #55 without presenting it as merged. Imported character/TV files and other workshop-only records remain explicitly labeled.

## Validation

Console build and 443 tests passed. Chromium close-ups confirmed textured fruit/basket and vase displays with no page errors. Blender 5.2.3 imported all 26 source templates with materials and identity local transforms. Structural comparison against the main-branch base confirmed only the 26 selected mesh references changed, with original scene roots, instance transforms/attributes, other resource records and binary bytes preserved. The new world is 26.66 MB (previously 23.43 MB); the reusable source kit is 3.22 MB.
