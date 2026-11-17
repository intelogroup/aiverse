#!/bin/bash
# UniMate first-light pipeline: wait for checkpoint, sample Go2 trot, animate to GLB.
set -x
cd ~/workspace/.build-tmp/unimate-test/repo
CKPT=outputs/unimate_uniml3d_f60_v3/checkpoints/checkpoint_step_150000.pt
WANT=1185836040
for i in $(seq 1 120); do
  SZ=$(stat -c %s "$CKPT" 2>/dev/null || echo 0)
  echo "ckpt size: $SZ / $WANT"
  [ "$SZ" -ge "$WANT" ] && break
  sleep 15
done
SZ=$(stat -c %s "$CKPT")
[ "$SZ" -ge "$WANT" ] || { echo "CKPT_INCOMPLETE"; exit 1; }
echo "CKPT_OK"

PY=../venv/bin/python
$PY -m unimate.inference.sample \
  --exp_dir outputs/unimate_uniml3d_f60_v3 \
  --asset assets/examples/unitree_go2 \
  --prompt "An object trots forward." \
  --num_repetitions 1 \
  --output_dir outputs/samples/go2 2>&1 | tail -30
echo "SAMPLE_EXIT=$?"
ls -la outputs/samples/go2/ 2>/dev/null

SKIP_INVALID=1 bash scripts/run_animate_motion.sh outputs/samples/go2 2>&1 | tail -30
echo "ANIMATE_EXIT=$?"
find outputs/samples/go2 -name "*.glb" -o -name "*.fbx" 2>/dev/null | head
echo "PIPELINE_DONE"
