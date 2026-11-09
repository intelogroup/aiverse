#!/usr/bin/env python3
"""Fine-tune a Laya-class decision head: ModernBERT-base encoder + one [MASK]
marker per option, a linear scorer reads each marker's hidden state, softmax
over {egg, not_egg}. Trained ONLY on the train split of dataset_a.jsonl;
temperature fitted on val; probabilities written for train/val/test.

Class balance: 6 positives in 427 train rows -> positives oversampled x12 in
training batches (~15% prevalence). No test/val row is ever trained on.

Implementation note (v2): sequences are padded and forwarded as true batches
(the v1 per-item loop was ~1.5 CPU-s/item and plateaued at >5 GB RSS on this
1.5-core box; protocol — data, split, seed, oversampling, lr, epochs, batch
size, temperature procedure — is unchanged)."""
import json, time, pathlib, random
import torch
from torch import nn
from transformers import AutoTokenizer, AutoModel

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
DATA = ROOT / "data/dataset_a.jsonl"
OUT = ROOT / "results"
MODEL = "answerdotai/ModernBERT-base"
torch.set_num_threads(4)

rows = [json.loads(l) for l in open(DATA)]
train = [r for r in rows if r["split"] == "train"]
val = [r for r in rows if r["split"] == "val"]
test = [r for r in rows if r["split"] == "test"]
print(f"train {len(train)} (egg {sum(r['label']=='egg' for r in train)}), "
      f"val {len(val)}, test {len(test)}", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL)
MASK_ID = tok.convert_tokens_to_ids("[MASK]")
PAD_ID = tok.pad_token_id if tok.pad_token_id is not None else 0
assert MASK_ID is not None and MASK_ID >= 0, "no [MASK] token"

def encode_ids(r):
    text = (f"{r['context']} Question: is this candidate an egg? "
            f"[MASK] egg [MASK] not egg")
    ids = tok(text, add_special_tokens=True)["input_ids"]
    assert len(ids) <= 192, f"seq too long: {len(ids)}"
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
    """batch: list of ((ids, pos), y). Returns logits (B, 2)."""
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
    idx = torch.tensor(mpos)                      # (B, 2)
    mh = h[torch.arange(len(seqs)).unsqueeze(1), idx]   # (B, 2, H)
    return model.scorer(mh).squeeze(-1)           # (B, 2)

random.seed(7)
pos_rows = [r for r in train if r["label"] == "egg"]
train_pool = train + pos_rows * 11            # 6 -> 72 positives among ~493
random.shuffle(train_pool)
train_b = make_batch(train_pool)

model = Head()
opt = torch.optim.AdamW(model.parameters(), lr=1e-5, weight_decay=0.01)
lossf = nn.CrossEntropyLoss()
EPOCHS = 4
t0 = time.time()
for ep in range(EPOCHS):
    model.train(); random.shuffle(train_b); tot = 0.0
    for i in range(0, len(train_b), 16):
        chunk = train_b[i:i + 16]
        logits = forward_batch(model, chunk)
        y = torch.tensor([c[1] for c in chunk])
        loss = lossf(logits, y)
        opt.zero_grad(); loss.backward(); opt.step()
        tot += loss.item() * len(chunk)
    print(f"epoch {ep+1}/{EPOCHS} loss {tot/len(train_b):.4f}  ({time.time()-t0:.0f}s)", flush=True)

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

# ---- temperature scaling on val (NLL over T) -------------------------------
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

# ---- latency: single-item inference on test --------------------------------
model.eval()
test_b = make_batch(test)
lat = []
with torch.no_grad():
    for item in test_b[:60]:
        s = time.perf_counter(); _ = forward_batch(model, [item]); lat.append(time.perf_counter() - s)
lat_ms = [x * 1000 for x in lat]
print(f"head latency single-item: mean {sum(lat_ms)/len(lat_ms):.1f} ms, p50 {sorted(lat_ms)[len(lat_ms)//2]:.1f} ms (n={len(lat_ms)}, CPU, forward only, tokenization excluded)", flush=True)

out_rows = []
for name, orig in [("train", train), ("val", val), ("test", test)]:
    ps = res[name]; psc = apply_T(np.array(ps), T_best)
    for r, p, pc in zip(orig, ps, psc):
        out_rows.append({"frame": r["frame"], "cand_idx": r["cand_idx"], "split": name,
                         "label": r["label"], "p_egg_raw": p[0], "p_egg_cal": pc[0],
                         "agnes_egg": r["agnes_egg"], "agnes_conf": r["agnes_conf"]})
with open(OUT / "head_probs.jsonl", "w") as fh:
    for r in out_rows: fh.write(json.dumps(r) + "\n")
torch.save(model.state_dict(), OUT / "head_state.pt")
json.dump({"temperature": T_best, "epochs": EPOCHS, "train_wall_s": time.time() - t0,
           "latency_ms_mean": sum(lat_ms) / len(lat_ms), "base_model": MODEL,
           "impl": "padded batch forward (v2); protocol unchanged from v1"},
          open(OUT / "head_meta.json", "w"), indent=1)
print("wrote results/head_probs.jsonl + head_meta.json; total wall", f"{time.time()-t0:.0f}s", flush=True)
