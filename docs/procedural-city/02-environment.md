# Environment (cloud container) — facts, not assumptions

## Installed / how
- **Blender 5.2.3 LTS headless**: tarball from `https://download.blender.org/release/Blender5.2/` (`blender-5.2.3-linux-x64.tar.xz`, sha256 checked against
  `blender-5.2.3.sha256`), extracted to `/opt`, symlink `/usr/local/bin/blender`. **No Blender MCP**: the ahujasid add-on needs a live GUI Blender; drive
  Blender with `blender -b --python script.py` instead. Does not survive container reclaim — reinstall.
- **Rendering needs `apt-get install -y libegl1 libgl1 libxkbcommon0 libxrender1 libxi6 libxxf86vm1 libsm6`**, else Blender exits with
  `Couldn't open libEGL.so.1`. After that EEVEE, Cycles and Workbench all render (EEVEE prints harmless `EGL_BAD_MATCH` lines). 1400x1000 EEVEE ≈ 25–90 s on 4 cores.
- Python 3.13 with PIL + numpy; **no matplotlib** (draw plan images with PIL). Node 22 at `/opt/node22`; `playwright` is global there; Chromium preinstalled.
- `bun` at `/root/.bun/bin/bun`; `bun install` at repo root takes ~3 s; vitest default env is jsdom — Recast tests start with `// @vitest-environment node`.
- Four cores, 15 GB RAM, ~30 GB disk allowance (per-session, `df` misleads).

## Browser with no GPU
Chromium flags that work: `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (add `--js-flags=--expose-gc`
for heap tests). Everything renders, but a 200k-tri city runs ~1 fps, so **simulated time crawls** (R3F caps dt at 0.05 s). Consequences:
you can verify correctness, CPU cost and memory; you cannot measure GPU time, and live sim tests (crowd, reversals) cover only seconds of sim time.
Use tiny viewports (480x320) to speed live probes, or test logic headless in vitest.

## Network (checked 2026-11-06)
Open: `download.blender.org`, `api.polyhaven.com` + `dl.polyhaven.org` (**send a `User-Agent`**, default urllib gets 403), `quaternius.com`,
`opengameart.org` (direct zip links work), `syntystore.com` (page only), `github.com` raw/codeload for public repos is untested here.
Blocked from this container: `kenney.nl` (403), `poly.pizza` (403), `github.com/KenneyNL` (403). `blenderkit.com` site redirects; its REST API works (below).
`drive.google.com` returns 302 (Quaternius' main hosting; not followed).

## Asset APIs and secrets (2026-11-06)
- **BlenderKit** add-on v3.21.3 (zip uploaded by user) installs via `blender -b --python-expr "import bpy; bpy.ops.extensions.package_install_files(filepath=..., repo='user_default')"`
  (or similar), but its local client does not run in `-b` mode ("connection refused"). Use the REST API directly:
  search `https://www.blendkit.com/api/v1/search/?query=<q> asset_type:model license:cc_zero is_free:true&page_size=N` (needs a `User-Agent`);
  download = GET the file's `downloadUrl` + `?scene_uuid=<any valid uuid4>` -> JSON `filePath` (signed URL) -> fetch the .glb.
- **API keys live ONLY as environment network secrets** (the proxy injects them); never write them into files, env vars or Blender prefs.
  BlenderKit: secret for `www.blendkit.com` (`Authorization: Bearer`). Sketchfab: secret for `api.sketchfab.com` (`Authorization: Token ...`) — run scripts that
  expect the env var as `SKETCHFAB_TOKEN=proxy-injected`.
- **BlendSwap**: via the blendswap MCP tools. `search_assets` free; `download_asset` = 7 free/day on the free plan, then 10 credits; .blend inside a zip;
  licences are uploader-declared (check each).

## Shell habits that avoid pain
- `sleep N` in the foreground is blocked; run long jobs in the background and wait with an `until grep ...; do sleep 5; done` Bash call with
  `run_in_background: true` (you get a completion notification), or the Monitor tool.
- Commit messages with heredocs inside `$(...)` broke once; write the message to a file and `git commit -F file`.
- The repo's stop hook demands commit+push whenever the tree is dirty — commit in phases rather than at the very end.
