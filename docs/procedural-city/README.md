# Procedural city — memory (read this first)

Everything a future session needs to continue the City 3 / procedural Blender → three.js work without
re-deriving it. Written 2026-11-06 at the end of a long build; update it, don't fork it.

| File | What it holds |
|---|---|
| `01-state-and-commands.md` | What exists, where it lives, how to rebuild/test/verify, current numbers and budgets |
| `02-environment.md` | The cloud container: what is installed, what network is open/blocked, how rendering works with no GPU |
| `03-blender-gltf-lessons.md` | Procedural geometry in Blender Python, UVs, materials, glTF/meshopt export — what worked and the traps |
| `04-threejs-runtime-lessons.md` | R3F/three: shadows, clipping cutaway, instancing, disposal, streaming, tone mapping |
| `05-verification-playbook.md` | How to prove things (visual harnesses, headless crowd tests, memory tests) and what NOT to trust |
| `06-failures-log.md` | Chronological: what broke, root cause, the fix. Skim before repeating a technique |
| `07-assets-and-licences.md` | Free asset sources tried, licences, reachability, conversion recipes |
| `08-animation-body-controller.md` | Turn clips, planted feet, controller design and measurements |
| `harness/` | The throwaway Playwright/three harnesses that caught real bugs (copy, `npm i`, run) |

## Ten rules that cost the most to learn

1. **Look at the pixels.** Screenshot every change and read it. Counters lied (handles "built" but empty; foot-slide
   metrics flattered by fewer low-foot frames). Most real bugs were found only visually.
2. **A test must observe the thing, not its bookkeeping.** Count meshes in `scene`, not `handle.drawCalls`.
3. **Measure the exporter.** Blender 5.2's meshopt export silently crushes positions to ~6 cm (patch in `build_city.py`).
4. **Materials are single-sided; anything seen from both sides is emitted twice.** Coplanar double-sided pairs z-fight.
5. **Keep decorations >= 3 cm off their surface** (2 mm z-fights; 4 cm needed the meshopt fix).
6. **Orbit target, not camera position,** decides which building the user is looking at.
7. **Never memoise something your effect cleanup destroys** (React StrictMode double-runs effects).
8. **Library + layout, never baked per building.** One asset library GLB, KB-sized layout JSON per room, instanced draws.
9. **Deterministic seeds everywhere;** per-building `random.Random(5000+idx)` so edits don't reshuffle the city.
10. **Commit in phases and write down failures the moment they happen** (this folder).

## Resume checklist
1. `git log --oneline -15` and read `01-state-and-commands.md` for the branch stack.
2. `bun install` at the repo root (3 s), `cd apps/console && bunx tsc -b && bunx vitest run`.
3. Blender: see `02-environment.md` (tarball + `apt install libegl1 libgl1 ...`), then `tools/city3/README.md` run order.
4. Look at the latest screenshots you produce before believing any number.
