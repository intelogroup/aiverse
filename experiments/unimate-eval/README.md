# UniMate evaluation — experiment record

**Question (2026-11-13):** is UniMate (Friedrich-M/UniMate —
text→motion for arbitrary skeletons) worth adopting for AIVerse
character animation, against the project's own Blender/library
pipeline?

**What UniMate is:** a research algorithm, not a product — a
SIGGRAPH Asia 2026 paper + PyTorch code + HuggingFace checkpoints
(1,185,836,040 B) under **CC BY-NC 4.0**, which blocks commercial
use. It generates 60-frame motion clips for arbitrary skeletons
from text.

**What was run:** the bench cloned the upstream repo, loaded the
checkpoints, and sampled a **Unitree Go2 trot**, verified
numerically and visually; the follow-cam render is
`unimate-go2-trot.mp4` (H.264, 640×360, 24 fps, 2.5 s). Sampling
took **2,854 s (~48 min) per motion** on this CPU box.

**Verdict: our own Blender/library pipeline wins for production.**
UniMate's niche is real but narrow: non-humanoid creatures,
one-offs, and previz — anywhere a 48-minute CPU sampling per clip
and a non-commercial license don't bite. It was **not** tested on
a cast rig (offered, not taken up).

## Contents

- `run_pipeline.sh` — the bench pipeline as run.
- `render_video.py`, `render_follow.py` — the verification renders
  (the follow-cam film).
- `unimate-go2-trot.mp4` — the verified Go2 trot.
- Logs: `sample.log` (the 2,854 s sampling), `pipeline.log`,
  `animate.log`, `render*.log`, `pip.log`.

## Re-run it

You need the upstream project (not included here — third-party,
CC BY-NC 4.0): clone https://github.com/Friedrich-M/UniMate,
download its HuggingFace checkpoints, then follow `run_pipeline.sh`
for the sampling + verification flow this bench used.

## Not included

- `repo/` — the upstream UniMate clone incl. its checkpoints
  (~1.2 GB; third-party code/weights under its own license).
- `venv/` (~1.7 GB) and `blender-libs/` (a third-party
  motion-synthesis library used by the render scripts).
- `frames/`, `frames_follow/` — the films' source frame sequences
  (intermediates; the MP4 is included).
