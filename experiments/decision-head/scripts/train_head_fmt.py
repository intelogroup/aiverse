#!/usr/bin/env python3
"""Fine-tune arm I: the v2 head protocol (scripts/train_head.py) with the
input state format selectable. Protocol UNCHANGED from v2 -- same data,
split, seed 7, positives oversampled x12, lr 1e-5, wd 0.01, 4 epochs,
batch 16, padded batch forwards, temperature fitted on val. The ONLY
changes: (1) the state text comes from FIELD of results/all_contexts.jsonl
(context | state_c | state_d) instead of the dataset digest, wrapped in
the same 'Question: ... [MASK] egg [MASK] not egg' template; (2) the
sequence cap rises 192 -> 640 tokens because the full formats are longer
(measured max printed); (3) outputs go to head_fmt_* so the digest head's
files are never clobbered; (4) per-epoch RSS is logged (v1 OOM history).

Usage: train_head_fmt.py FIELD   (FIELD in {context, state_c, state_d})
Trains ONLY on train-split rows; val used solely for temperature; test
rows are inference-only. Leakage assertions run before training."""
import json, time, pathlib, random, sys
import torch
from torch import nn
from transformers import AutoTokenizer, AutoModel

FIELD = sys.argv[1]
assert FIELD in ("context", "state_c", "state_d")
BATCH = int(sys.argv[2]) if len(sys.argv) > 2 else 16
GRAD_CKPT = len(sys.argv) > 3 and sys.argv[3] == "gc"
ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
OUT = ROOT / "results"
MODEL = "answerdotai/ModernBERT-base"
torch.set_num_threads(4)

def rss_mb():
    for l in open("/proc/self/status"):
        if l.startswith("VmRSS"): return int(l.split()[1]) / 1024
    return -1

rows = [json.loads(l) for l in open(ROOT / "results/all_contexts.jsonl")]
train = [r for r in rows if r["split"] == "train"]
val = [r for r in rows if r["split"] == "val"]
test = [r for r in rows if r["split"] == "test"]
print(f"field {FIELD}; train {len(train)} (egg {sum(r['label']=='egg' for r in train)}), "
      f"val {len(val)}, test {len(test)}", flush=True)

# ---- leakage assertions (before any training) ------------------------------
cde120 = {(json.loads(l)["frame"], json.loads(l)["cand_idx"])
          for l in open(ROOT / "results/cde_items.jsonl")}
tr_keys = {(r["frame"], r["cand_idx"]) for r in train}
va_keys = {(r["frame"], r["cand_idx"]) for r in val}
assert not (cde120 & tr_keys), "LEAK: test-120 key in train"
assert not (cde120 & va_keys), "LEAK: test-120 key in val"
tr_frames = {r["frame"] for r in train}; va_frames = {r["frame"] for r in val}
te_frames = {r["frame"] for r in test}
assert not (tr_frames & te_frames) and not (tr_frames & va_frames) and not (va_frames & te_frames), \
    "LEAK: frame shared across splits"
print("leakage assertions passed: no test-120 key in train/val; frames disjoint across splits", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL)
MASK_ID = tok.convert_tokens_to_ids("[MASK]")
PAD_ID = tok.pad_token_id if tok.pad_token_id is not None else 0
assert MASK_ID is not None and MASK_ID >= 0, "no [MASK] token"

def encode_ids(r):
    text = (f"{r[FIELD]} Question: is this candidate an egg? "
            f"[MASK] egg [MASK] not egg")
    ids = tok(text, add_special_tokens=True)["input_ids"]
    assert len(ids) <= 640, f"seq too long: {len(ids)}"
    pos = [i for i, t in enumerate(ids) if t == MASK_ID]
    assert len(pos) == 2, f"expected 2 masks, got {len(pos)}"
    return ids, pos

ENC = {}
def enc_of(r):
    k = (r["frame"], r["cand_idx"])
    if k not in ENC: ENC[k] = encode_ids(r)
    return ENC[k]

def make_batch(sub):
    return [(enc_of(r), 0 if r["label"] == "egg" else 1) for r in sub]

class Head(nn.Module):
    def __init__(self):
        super().__init__()
        self.enc = AutoModel.from_pretrained(MODEL)
        self.scorer = nn.Linear(self.enc.config.hidden_size, 1)

def forward_batch(model, batch):
    seqs = [b[0] for b in batch]
    maxlen = max(len(s[0]) for s in seqs)
    ids = torch.full((len(seqs), maxlen), PAD_ID, dtype=torch.long)
    att = torch.zeros((len(seqs), maxlen), dtype=torch.long)
    mpos = []
    for i, (s_ids, s_pos) in enumerate(seqs):
        ids[i, :len(s_ids)] = torch.tensor(s_ids)
        att[i, :len(s_ids)] = 1
        mpos.append(s_pos)
    h = model.enc(input_ids=ids, attention_mask=att).last_hidden_state
    idx = torch.tensor(mpos)
    mh = h[torch.arange(len(seqs)).unsqueeze(1), idx]
    return model.scorer(mh).squeeze(-1)

random.seed(7)
pos_rows = [r for r in train if r["label"] == "egg"]
train_pool = train + pos_rows * 11
random.shuffle(train_pool)
train_b = make_batch(train_pool)
maxlen_seen = max(len(b[0][0]) for b in train_b)
print(f"train pool {len(train_b)} (positives x12 -> {len(pos_rows)*12}); max train seq {maxlen_seen} tokens; RSS {rss_mb():.0f} MB", flush=True)

model = Head()
if GRAD_CKPT:
    # memory knob only: identical math/gradients, activations recomputed
    # in backward instead of stored. Batch size stays at the v2 value.
    model.enc.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False})
    print("gradient checkpointing ON (memory measure; math unchanged)", flush=True)
opt = torch.optim.AdamW(model.parameters(), lr=1e-5, weight_decay=0.01)
lossf = nn.CrossEntropyLoss()
EPOCHS = 4
print(f"training start: batch {BATCH}, RSS {rss_mb():.0f} MB", flush=True)
t0 = time.time()
for ep in range(EPOCHS):
    model.train(); random.shuffle(train_b); tot = 0.0
    for i in range(0, len(train_b), BATCH):
        chunk = train_b[i:i + BATCH]
        logits = forward_batch(model, chunk)
        y = torch.tensor([c[1] for c in chunk])
        loss = lossf(logits, y)
        opt.zero_grad(); loss.backward(); opt.step()
        tot += loss.item() * len(chunk)
    print(f"epoch {ep+1}/{EPOCHS} loss {tot/len(train_b):.4f}  ({time.time()-t0:.0f}s) RSS {rss_mb():.0f} MB", flush=True)

@torch.no_grad()
def probs_for(sub):
    model.eval(); out = []
    b = make_batch(sub)
    for i in range(0, len(b), 32):
        lg = forward_batch(model, b[i:i + 32])
        out.extend(torch.softmax(lg, -1).tolist())
    return out

res = {name: probs_for(sub) for name, sub in
       [("train", train), ("val", val), ("test", test)]}

import numpy as np
def nll_T(T, ps, ys):
    z = np.log(np.clip(ps, 1e-9, 1)) / T
    z = z - z.max(axis=1, keepdims=True)
    p = np.exp(z); p /= p.sum(axis=1, keepdims=True)
    return -np.mean(np.log(np.clip(p[np.arange(len(ys)), ys], 1e-12, 1)))
ys_val = np.array([0 if r["label"] == "egg" else 1 for r in val])
ps_val = np.array(res["val"])
Ts = np.linspace(0.3, 5.0, 95)
T_best = float(Ts[min(range(len(Ts)), key=lambda i: nll_T(Ts[i], ps_val, ys_val))])
print(f"temperature fitted on val: T={T_best:.2f} (val NLL {nll_T(1.0, ps_val, ys_val):.3f} -> {nll_T(T_best, ps_val, ys_val):.3f})", flush=True)

def apply_T(ps, T):
    z = np.log(np.clip(ps, 1e-9, 1)) / T
    z = z - z.max(axis=1, keepdims=True)
    p = np.exp(z); return (p / p.sum(axis=1, keepdims=True)).tolist()

model.eval()
test_b = make_batch(test)
lat = []
with torch.no_grad():
    for item in test_b[:60]:
        s = time.perf_counter(); _ = forward_batch(model, [item]); lat.append(time.perf_counter() - s)
lat_ms = [x * 1000 for x in lat]
print(f"head latency single-item: mean {sum(lat_ms)/len(lat_ms):.1f} ms, p50 {sorted(lat_ms)[len(lat_ms)//2]:.1f} ms (n={len(lat_ms)}, CPU, forward only)", flush=True)

out_rows = []
for name, orig in [("train", train), ("val", val), ("test", test)]:
    ps = res[name]; psc = apply_T(np.array(ps), T_best)
    for r, p, pc in zip(orig, ps, psc):
        out_rows.append({"frame": r["frame"], "cand_idx": r["cand_idx"], "split": name,
                         "label": r["label"], "p_egg_raw": p[0], "p_egg_cal": pc[0],
                         "agnes_egg": r["agnes_egg"], "field": FIELD})
with open(OUT / "head_fmt_probs.jsonl", "w") as fh:
    for r in out_rows: fh.write(json.dumps(r) + "\n")
torch.save(model.state_dict(), OUT / "head_fmt_state.pt")
json.dump({"temperature": T_best, "epochs": EPOCHS, "train_wall_s": time.time() - t0,
           "latency_ms_mean": sum(lat_ms) / len(lat_ms), "base_model": MODEL,
           "field": FIELD, "batch": BATCH, "grad_ckpt": GRAD_CKPT,
           "max_train_seq_tokens": maxlen_seen,
           "peak_rss_mb": rss_mb(),
           "impl": "v2 protocol (train_head.py) with selectable state format; seq cap 640"},
          open(OUT / "head_fmt_meta.json", "w"), indent=1)
print("wrote results/head_fmt_probs.jsonl + head_fmt_meta.json; total wall", f"{time.time()-t0:.0f}s", flush=True)
