# Filming agent runs

How to record a watchable video of an agent run — the standard, the one
capture technique proven to work, and the surfaces it works on. Written
2026-11-23 from the car-search filming receipt (VM failure + Mac success,
same day); numbers below are measured, not estimated.

## The standard (Jim, 2026-11-09)

- **Third-person follow-cam of the character**, captured from an
  independent observer page/process — never the agent's first-person
  viewport (its perception stalls starve any capture attached to it).
- **≥10 fps ACTUAL captured frames, verified by frame count** (ffprobe
  frame count ÷ duration). A renderer's claimed fps is not evidence.
- **H.264 MP4, faststart, yuv420p** — the films are watched on iOS;
  WebM does not play there.
- A film below the frame density is a failed deliverable: report it as
  such. Never speed a capture up to fake the rate.

## The technique that works: CDP screencast + timestamp-true assembly

1. **Capture** with CDP `Page.startScreencast` from a script driving the
   observer browser. Every screencast frame carries its real CDP capture
   timestamp — keep them; they are the film's clock.
2. **Assemble** with ffmpeg's concat demuxer, giving each frame its
   measured duration (the gap to the next frame's timestamp). This is
   timestamp-true assembly: where the renderer produced 20 fps the film
   shows 20 fps; where it dipped, the frame holds a beat longer. No
   speedup, no interpolation, no assumed constant frame rate.
3. **Encode** `libx264`, `-pix_fmt yuv420p`, `-movflags +faststart`.
4. **Verify** before calling it done: ffprobe frame count ÷ duration =
   actual fps; per-10 s bucket counts (no starved stretches — the proven
   film held 138–205 frames in every 10 s bucket, largest single gap
   1.32 s); eyeball stills (follow chip visible, the leg of the run you
   think you're looking at).

Concat file shape (one `duration` line per frame, last frame repeated):

```
file 'frame-000001.jpg'
duration 0.052
file 'frame-000002.jpg'
duration 0.049
```

```bash
ffmpeg -f concat -safe 0 -i frames.txt -c:v libx264 -pix_fmt yuv420p \
  -movflags +faststart out.mp4
```

## The surface rule: filming needs a GPU browser

The sandbox VM has no GPU (`/dev/dri` absent); Chromium falls back to
SwiftShader, and the current city scene is far beyond it. Measured on
the VM (2026-11-22/23, real console page, follow-cam engaged):

- rAF probe at 640×360: **0.20 fps** (3 frames / 15 s, median frame
  delta 4,700 ms); idle at spawn: **0.05 fps** (1 frame / 20 s).
- The batching trial corroborates: ~0.03–0.1 fps baseline, median frame
  delta 9,689 ms at the settled spawn view
  (`apps/console/batching-trial/TRIAL-NOTES.md`, `film.json`).

On that surface **every** capture mechanism starves, regardless of
recorder design — see "What does not work" below. Do not burn a session
re-proving this; the verdict is recorded twice.

**Proven working surface: Jim's Mac (Apple Silicon).** Run the full
local stack on the Mac (user-space bun + Postgres + Redis; sim,
gateway with `AIVERSE_WORLD_MODE=1`, console vite), and film the
console in the muse-agent Chrome, driven via CDP :9222 from a script
on the Mac. Measured 2026-11-23 on the car-search drive (spawn → find
car-tea → drive 140 m → arrive): **17.82 fps actual at 1280×720** over
107.96 s (1,923 screencast frames); idle capture on the same setup
measured 20.02 fps. Working scripts live in the Mac clone at
`~/aiverse-film/.film/` (`film-mac2.ts` is the capture script;
`probe.ts` stages owner+agent+visit, `act.ts` drives the scenario).

## Recipe

1. Bring up the local stack where the filming browser can reach it:
   sim, gateway (`AIVERSE_WORLD_MODE=1` + `SIM_URL`/`SIM_INTERNAL_SECRET`),
   console vite with **`VITE_ASSET_BASE=""`** — the console defaults to
   the R2 CDN for GLBs; local filming must serve the local assets.
2. Stage the agent: register a fresh owner+agent, start the visit,
   attach the body (`probe.ts` pattern). Act ids must match
   `^[a-zA-Z0-9-]{1,80}$` — underscores 400 at the gateway.
3. Observer page: open the console `?stream=1` signed in as that owner,
   wait for the loading overlay to clear, click the agent's Follow chip
   (OwnerFollowCam). Warm the profile up first — a cold browser profile
   stalled 19.5 s on asset loading during the first Mac attempt.
4. Start the screencast capture, then run the scenario. Stop, assemble
   timestamp-true, verify per above.

## Gotcha: the follow cam loses a driving agent (bug in current main)

Filming a drive hits a real console bug. `GlbWorld` polls `pickOwnBody`
every 400 ms; the moment the agent enters a car, its pose leaves the
roster stream, `ownBody` goes null, the follow chip unmounts and
`following` is forced false. `OwnerFollowCam` already implements the
intended fallback (follow the nearest fleet car from the body's last
position), but the parent unmounts it before that code can run — the
fallback is dead code. Measured on the first Mac attempt: chip read
"Following" through 40 s, null from 45 s (enter_vehicle) to the end of
the drive; the whole drive leg was lost.

**Workaround used for the 2026-11-23 film (local only, NOT merged):**
in `apps/console/src/features/world/GlbWorld.tsx`, the ownBody poll
keeps the last known body when `pickOwnBody` returns null
(`b === null ? prev : …`), which keeps the chip mounted and lets the
fleet-car fallback do its designed job. Verified: chip "Following"
continuously 0–106 s, straight through enter_vehicle. This is a
workaround, not the fix — the upstream fix needs a decision on when a
stale body finally drops (visit end already clears it via
`onAgentGone`).

## What does not work (stop retrying)

- **Filming the full city scene on the GPU-less VM**, at any resolution
  tried (640×360 included): 0.05–0.2 fps. The surface is the limit, not
  the recorder.
- **MediaRecorder** (`canvas.captureStream`, the VerseRecorder
  mechanism) on a starving compositor: one run produced 0 bytes; a
  second produced bytes, but the post-run pull-out wedged for 6+ minutes
  behind the render thread and the capture was lost with the page.
- **CDP screencast on the VM**: 0 frames in 15 s.
- **Playwright screenshot bursts on the VM**: every shot exceeded even
  a 120 s timeout during the run; 0 frames captured.
- **Invalidation pumping** (CDP mouse moves to force frames): no
  improvement before the probe's own evaluate calls stalled.
