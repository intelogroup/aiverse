# Packaging exclusions (pushed branch only)

Two generated files in this trial directory are NOT in the pushed branch:

- `bazaar-stall-262k.ply` — 17,826,208 bytes
- `bazaar-stall-1m.ply` — 68,000,417 bytes

They exceed the per-file limit (~12.6 MB) of the GitHub git-database API
used to publish this branch from the sandbox, where direct HTTPS git push
is blocked. Both files are fully regenerable from the generator script in
this directory:

    python3 apps/console/splat-trial/generate_splats.py

which writes `bazaar-stall-262k.ply` (exactly 262,144 gaussians) and
`bazaar-stall-1m.ply` (exactly 1,000,000 gaussians) into this directory.

The 262k SPZ (`bazaar-stall-262k.spz`, 2,587,677 bytes) IS included.
Everything else in the pushed tree is byte-identical to the local trial
branch: pushed tree == local tree minus the two files above.
