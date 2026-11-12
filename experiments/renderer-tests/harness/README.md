# harness (Mac run, 2026-11-12)

- `webgl-webgpu/` — `index.html` (three 0.170.0 single-GLB page, `?r=webgl|webgpu&glb=`) + `run.py` (Playwright, Chrome channel). Needs `npm i three@0.170.0` and the GLBs next to the page.
- `native-wgpu/` — own wgpu 24 renderer: `cargo run --release -- <glb> <cam.json> <out.png>`. CPU rest-pose skinning, lambert + normal map, no specular.
- `native-bevy/` — Bevy 0.20.1 screenshot app: `bevy-shot ./cast-jim.glb out.png` (opens a window briefly).
- `native-rend3/` — rend3 0.3.0. Needs, to run on current macOS: (1) vendor `wgpu-hal` 0.12.5 and neutralise every `set_label` / `push_debug_group` / `pop_debug_group` / `insert_debug_signpost` call in `src/metal/{device,command}.rs` via `[patch.crates-io]`; (2) `image` 0.23 with the `jpeg` feature. The vendored crate is not committed.

Camera used by all renderers: `../results/cam-cast-jim.json` (vfov 30°, 768×768).
