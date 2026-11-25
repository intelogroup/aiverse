"""Repair a texture with LaMa (big-lama, CPU) — hole filling, watermark/defect removal.

    python3 tools/city3/inpaint_texture.py --image TEX.png --mask MASK.png --out FIXED.png

The mask is white where the texture must be rebuilt. Notes from the first run on this machine:
- `pip install simple-lama-inpainting` pulls a 196 MB TorchScript checkpoint into ~/.cache/torch.
- the archive bundles CUDA tensors and simple-lama calls torch.jit.load without map_location, which
  fails on a CPU-only torch build; the patch below is required, not cosmetic.
- 512x512 repair measured 1.6 s on CPU. `--device mps` is untested for TorchScript here.
"""
import argparse, os, time
import torch
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--image', required=True)
ap.add_argument('--mask', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--device', default='cpu')
args = ap.parse_args()

_orig_load = torch.jit.load

def _load(*a, **k):
    k.pop('map_location', None)
    return _orig_load(*a, map_location=torch.device('cpu'), **k)

torch.jit.load = _load  # CPU-only torch: the checkpoint's CUDA tensors need an explicit map

from simple_lama_inpainting import SimpleLama  # noqa: E402  (import after the patch)

img = Image.open(args.image).convert('RGB')
mask = Image.open(args.mask).convert('L')
t0 = time.time()
lama = SimpleLama(device=torch.device(args.device))
model_s = time.time() - t0
t1 = time.time()
out = lama(img, mask)
run_s = time.time() - t1
out.save(args.out)
print(f'inpainted {img.size} in {run_s:.2f}s (model load {model_s:.1f}s) -> {args.out} '
      f'({os.path.getsize(args.out)} bytes)')
