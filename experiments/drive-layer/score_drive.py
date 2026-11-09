#!/usr/bin/env python3
"""score_drive.py — independent scoring of drive-layer runs against
the registered predictions P1–P4 of DRIVE-LAYER-SPEC.md §4.

Gate G4 of the drive program: the headline never rests on the
supervisor's live state. Everything here is recomputed from run
artifacts — trace.jsonl, truth.jsonl, drives.jsonl, summary.json,
gauntlet.json (the receipt) — pooled across the B+C runs given, with
run identity kept in the per-run detail.

HONESTY RULES (this rig family's standing discipline):
- Missing core inputs (trace / truth / drives for any pooled run)
  FAIL LOUD: every verdict is INSUFFICIENT DATA, the reasons are
  printed, the report is still written, and the exit code is 2. A
  gauntlet baseline dir (condition A — no drives.jsonl, by design)
  scores exactly that way; it is never dressed up as data.
- A prediction whose inputs exist but are too thin for its
  registered thresholds is UNDERPOWERED, with the numbers shown.
  Nothing is interpolated, nothing is fabricated.
- All metrics are SIM-TIME based. Wall clock appears only in the
  disclosure block: resumed runs (interruptions.json / the receipt's
  checkpoint block) are consumed correctly — drive state at time t
  is folded from drives.jsonl in FILE ORDER (every row carries an
  absolute level_after, and a resume's `checkpoint-restore` seam
  rows sit in the file exactly where the rewind happened, so later
  rows win the rewound interval), and wall gaps never enter a metric.

Instruments (spec §4, operationalized — approximations stated):
- Sightings: trace `look-recall` rows (agent A), `reported[]`
  entries. Range r = distance from the truth pose at capture to the
  estimate; σ_2d = σ_vlm(r) = 0.32·r (percept_uncertainty).
- Pursuit: min truth distance to the estimate within 120 sim-s of
  capture closes ≥ 50% of the initial range (or the matched egg is
  collected inside the window).
- Windows: satiated = energy ≥ 80 AND perception ≥ 12; deprived =
  energy < 30 OR perception ≤ 5; state at capture from drives.jsonl.
- P1σ*: per-window logistic fit of pursued vs σ_2d; σ* = the σ at
  which pursuit probability crosses 0.5.
- P1 confident-wrong: a HIGH-confidence pursuit whose target was no
  real egg (unmatched) AND the agent committed (came within 2.5 m of
  the estimate or touched the decoy) AND nothing was collected in
  the window — the observable shape of a truth-gate refusal / empty
  arrival. Pursuits of matched (real) eggs are never "wrong".
- P2 rest events: drives.jsonl `rest` rows grouped (≤ 15 sim-s
  gaps); a detour is measured against the stage objective active at
  rest start (S1 stand / S2 designated egg / S3's eventually
  collected visual egg; otherwise unclassifiable). Segment-blocked
  intervals cannot fake a rest (rests exist only as drive events);
  an agent already sitting at the source is not a detour.
- P3 cells: 12 m grid over the truth track, post-S2 only.

Usage: score_drive.py RUN_DIR [RUN_DIR ...] [--pair DIR DIR]
       [--out PATH]
Exit: 0 = every prediction scored (CONFIRMED / REFUTED /
      UNDERPOWERED); 2 = at least one INSUFFICIENT DATA.
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent
EXP = HERE.parent
GAUNTLET_DIR = EXP / "gauntlet"
EGG_PREP = EXP / "egg-hunt" / "prep"
sys.path.insert(0, str(EXP / "visibility"))
import percept_uncertainty as PU  # noqa: E402

SEALED_G = json.loads(
    (GAUNTLET_DIR / "prep/ground_truth_gauntlet.json").read_text())
SEALED_D = json.loads((HERE / "prep/ground_truth_drive.json")
                      .read_text())
GT = {e["id"]: e for e in
      json.loads((EGG_PREP / "ground_truth.json").read_text())["eggs"]}
S1_STAND = SEALED_G["stages"]["S1"]["stand"]
S2_DESIGNATED = SEALED_G["stages"]["S2"]["designated_egg"]
DECOY_POS = SEALED_G["stages"]["S4"]["decoy"]["pos"]
DECOY_PROPOSED_R = SEALED_G["stages"]["S4"]["decoy"]["proposed_radius_m"]
FIRED_LOOK_KINDS = ("look-recall", "look-failed", "perception-failed")
REST_ENGAGE_M = 4.0          # drive_layer build constant A1
CLOSURE = tuple(SEALED_D["r1_closure_window_sim"])

INSUFFICIENT = "INSUFFICIENT DATA"
UNDERPOWERED = "UNDERPOWERED"


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def load_jsonl(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except Exception:  # noqa: BLE001 — a torn tail row is
                pass            # the kill's signature; it is skipped
    return rows


def load_json(path):
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else None


# ---------------------------------------------------------------------------
# One run's artifacts, digested once

class RunData:
    def __init__(self, run_dir):
        self.dir = Path(run_dir)
        self.name = self.dir.name
        self.missing = []
        for f in ("trace.jsonl", "truth.jsonl", "drives.jsonl"):
            if not (self.dir / f).exists():
                self.missing.append(f)
        self.trace = (load_jsonl(self.dir / "trace.jsonl")
                      if "trace.jsonl" not in self.missing else [])
        self.truth = (load_jsonl(self.dir / "truth.jsonl")
                      if "truth.jsonl" not in self.missing else [])
        self.drives = (load_jsonl(self.dir / "drives.jsonl")
                       if "drives.jsonl" not in self.missing else [])
        self.summary = load_json(self.dir / "summary.json") or {}
        self.receipt = load_json(self.dir / "gauntlet.json") or {}
        stages = self.receipt.get("stages")
        if not stages:
            stages = load_json(self.dir / "stages.json") or {}
        self.stages = stages
        self.has_stage_record = bool(stages) or \
            (self.dir / "stages.json").exists()
        self.drive_receipt = self.receipt.get("drive_layer") or {}
        self.rest_sources = (
            self.drive_receipt.get("rest_sources")
            or [SEALED_D["r1"], SEALED_D["r2"]])
        self.endowments = self.drive_receipt.get("endowments") or {
            "energy": 100.0, "perception": 15}
        # disclosure: resumed or not, and how often
        ck = self.receipt.get("checkpoint") or {}
        inter = load_json(self.dir / "interruptions.json")
        if inter is None:
            inter = ck.get("interruptions") or []
        self.interruptions = inter
        self.resumed = bool(inter)
        # derived series
        self.track = [(float(r["t_sim"]), [r["a"][0], r["a"][2]])
                      for r in self.truth if r.get("a")]
        self.fired_looks = [float(r["t_sim"]) for r in self.trace
                            if r.get("kind") in FIRED_LOOK_KINDS
                            and r.get("agent") == "A"
                            and isinstance(r.get("t_sim"), (int, float))]
        self.collects = [{"t": float(r["t_sim"]), "egg": r["egg"]}
                         for r in self.trace
                         if r.get("kind") == "COLLECT"
                         and r.get("agent") == "A"
                         and isinstance(r.get("t_sim"), (int, float))]
        self.sightings = []
        for r in self.trace:
            if r.get("kind") != "look-recall" or r.get("agent") != "A":
                continue
            t_cap = r.get("t_sim")
            if not isinstance(t_cap, (int, float)):
                continue
            pose = self.pos_at(t_cap)
            if pose is None:
                continue
            for rep in r.get("reported") or []:
                est = rep.get("est")
                if not est:
                    continue
                rng = dist(pose, est)
                self.sightings.append({
                    "t": float(t_cap), "est": [est[0], est[1]],
                    "matched": rep.get("matched"),
                    "confidence": rep.get("confidence"),
                    "range_m": rng, "sigma_2d": PU.sigma_vlm(rng),
                    "pose": pose})

    # -- timeline helpers (file order; see module docstring) -----------

    def pos_at(self, t):
        best, best_dt = None, None
        for tt, pos in self.track:
            dt = abs(tt - t)
            if best_dt is None or dt < best_dt:
                best, best_dt = pos, dt
        return best

    def track_window(self, t0, t1):
        return [(tt, pos) for tt, pos in self.track if t0 <= tt <= t1]

    def levels_at(self, t):
        """(energy, perception) at sim t: fold drives.jsonl in file
        order over rows with t_sim <= t; level_after is absolute, so
        a resume's seam rows correctly override the dead leg's rows
        in the rewound interval."""
        e = float(self.endowments["energy"])
        p = int(self.endowments["perception"])
        for r in self.drives:
            if float(r["t_sim"]) > t:
                continue
            if r["var"] == "energy":
                e = float(r["level_after"])
            elif r["var"] == "perception":
                p = int(r["level_after"])
        return e, p

    def window_at(self, t):
        e, p = self.levels_at(t)
        if e >= 80 and p >= 12:
            return "satiated"
        if e < 30 or p <= 5:
            return "deprived"
        return "neither"

    def stage_t(self, key):
        rec = self.stages.get(key)
        return float(rec["t_sim"]) if rec and rec.get("t_sim") else None


# ---------------------------------------------------------------------------
# P1 — pursuit curves + confident-wrong

def compute_pursuits(run):
    out = []
    for s in run.sightings:
        t0, est = s["t"], s["est"]
        r0 = s["range_m"]
        if r0 < 2.0:
            continue  # degenerate: the agent was already standing on it
        min_d = r0
        for _tt, pos in run.track_window(t0, t0 + 120.0):
            min_d = min(min_d, dist(pos, est))
        collected = bool(s["matched"]) and any(
            c["egg"] == s["matched"] and t0 <= c["t"] <= t0 + 120.0
            for c in run.collects)
        any_collect = any(t0 <= c["t"] <= t0 + 120.0
                          for c in run.collects)
        pursued = collected or min_d <= 0.5 * r0
        decoy_touch = any(
            dist(pos, DECOY_POS) <= 1.5
            for _tt, pos in run.track_window(t0, t0 + 120.0))
        wrong = (s["confidence"] == "high" and pursued
                 and s["matched"] is None and not any_collect
                 and (min_d <= 2.5 or decoy_touch))
        out.append({"run": run.name, "t": t0, "sigma_2d": s["sigma_2d"],
                    "range_m": r0, "pursued": pursued,
                    "confidence": s["confidence"],
                    "matched": s["matched"], "wrong": wrong,
                    "window": run.window_at(t0)})
    return out


def fit_sigma_star(points):
    """Logistic fit pursued ~ σ; returns σ* (p = 0.5 crossing) or
    None when the data cannot support one (too few, no variance in
    σ, single-class labels, or no falloff — pursuit never drops)."""
    if len(points) < 8:
        return None
    xs = [p["sigma_2d"] for p in points]
    ys = [1.0 if p["pursued"] else 0.0 for p in points]
    if max(xs) - min(xs) < 0.5 or all(y == ys[0] for y in ys):
        return None
    mu = sum(xs) / len(xs)
    sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs)) or 1.0
    a = b = 0.0
    lr, n = 0.5, len(points)
    for _ in range(2000):
        ga = gb = 0.0
        for x, y in zip(xs, ys):
            z = (x - mu) / sd
            pr = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, a + b * z))))
            ga += pr - y
            gb += (pr - y) * z
        a -= lr * ga / n
        b -= lr * gb / n
    if b >= -1e-6:
        return None  # no falloff: σ* is beyond the observed range
    return mu + (-a / b) * sd


def score_p1(runs):
    pursuits = []
    for r in runs:
        pursuits.extend(compute_pursuits(r))
    by_w = {w: [p for p in pursuits if p["window"] == w]
            for w in ("satiated", "deprived", "neither")}
    detail = {"pursuits_total": len(pursuits),
              "pursuits_per_window": {w: len(v)
                                      for w, v in by_w.items()},
              "pursued_per_window": {
                  w: sum(1 for p in v if p["pursued"])
                  for w, v in by_w.items()}}
    stars = {w: fit_sigma_star(by_w[w]) for w in ("satiated", "deprived")}
    detail["sigma_star"] = {w: (None if v is None else round(v, 2))
                            for w, v in stars.items()}
    cw = {}
    for w in ("satiated", "deprived"):
        hp = [p for p in by_w[w]
              if p["pursued"] and p["confidence"] == "high"]
        cw[w] = {"high_pursuits": len(hp),
                 "wrong": sum(1 for p in hp if p["wrong"]),
                 "rate": (round(sum(1 for p in hp if p["wrong"])
                                / len(hp), 3) if hp else None)}
    detail["confident_wrong"] = cw
    n_sat = detail["pursued_per_window"]["satiated"]
    n_dep = detail["pursued_per_window"]["deprived"]
    if stars["satiated"] is None or stars["deprived"] is None:
        return {**detail, "verdict": UNDERPOWERED,
                "reason": "a pursuit curve could not be fitted in "
                          "one window (too few sightings, no σ "
                          "variance, or no falloff)"}
    if n_sat < 15 or n_dep < 15:
        return {**detail, "verdict": UNDERPOWERED,
                "reason": f"spec gate: ≥15 pursuits per window "
                          f"(satiated {n_sat}, deprived {n_dep})"}
    if cw["satiated"]["high_pursuits"] < 5 or \
            cw["deprived"]["high_pursuits"] < 5:
        return {**detail, "verdict": UNDERPOWERED,
                "reason": "fewer than 5 high-confidence pursuits in "
                          "a window — a doubling ratio would be noise"}
    ratio_star = stars["deprived"] / stars["satiated"]
    ratio_cw = (cw["deprived"]["rate"] / cw["satiated"]["rate"]
                if cw["satiated"]["rate"] else
                (float("inf") if cw["deprived"]["rate"] else 1.0))
    detail["sigma_star_ratio"] = round(ratio_star, 2)
    detail["confident_wrong_ratio"] = (
        round(ratio_cw, 2) if ratio_cw != float("inf") else "inf")
    if ratio_star >= 1.25 and ratio_cw >= 2.0:
        verdict = "CONFIRMED"
    elif ratio_star < 1.10 and ratio_cw < 1.25:
        verdict = "REFUTED"
    else:
        verdict = UNDERPOWERED
        detail["reason"] = ("effect present but below the "
                            "registered confirm thresholds, and "
                            "above the refute thresholds")
    return {**detail, "verdict": verdict}


# ---------------------------------------------------------------------------
# P2 — replenishment detours

def rest_events(run):
    """Group drives.jsonl rest rows into rest events. A row's t_sim
    is the END of its 10 sim-s step; an event starts 10 s earlier."""
    rows = [r for r in run.drives if r.get("cause") == "rest"]
    events = []
    for r in rows:
        t = float(r["t_sim"])
        if events and t - events[-1]["rows"][-1] <= 15.0:
            events[-1]["rows"].append(t)
            events[-1]["t_end"] = t
        else:
            events.append({"rows": [t], "t_start": t - 10.0,
                           "t_end": t,
                           "energy_before": float(r["level_after"])
                           - float(r["delta"])})
    for ev in events:
        pos = run.pos_at(ev["t_start"])
        src, sd = None, None
        for s in run.rest_sources:
            d = dist(pos, s["pos"]) if pos else None
            if d is not None and (sd is None or d < sd):
                src, sd = s, d
        ev["source"] = src["id"] if src and sd <= REST_ENGAGE_M + 2.0 \
            else None
        ev["source_pos"] = src["pos"] if src else None
        ev["pos_at_start"] = pos
    return events


def objective_at(run, t):
    """(stage, target_pos|None) of the objective active at t."""
    if run.stage_t("S1") is None or t < run.stage_t("S1"):
        return "S1", S1_STAND
    if run.stage_t("S2") is None or t < run.stage_t("S2"):
        return "S2", GT[S2_DESIGNATED]["pos"]
    if run.stage_t("S3") is None or t < run.stage_t("S3"):
        rec = run.stages.get("S3") or {}
        egg = rec.get("egg")
        return "S3", (GT[egg]["pos"] if egg in GT else None)
    return None, None


def seg_point_dist(p, a, b):
    ax, az = a
    bx, bz = b
    px, pz = p
    dx, dz = bx - ax, bz - az
    ll = dx * dx + dz * dz
    if ll == 0:
        return dist(p, a)
    u = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / ll))
    return math.hypot(px - (ax + u * dx), pz - (az + u * dz))


def classify_rest(run, ev):
    """One rest event → (class, detail). Classes: detour, reroute,
    compulsion, spawn-adjacent, already-there, unclassifiable,
    not-mid-task."""
    t = ev["t_start"]
    # limp-home compulsion: a limp-home-on with no -off before the rest
    limp = False
    for r in run.drives:
        if float(r["t_sim"]) > ev["t_end"]:
            break
        if r.get("cause") == "limp-home-on":
            limp = True
        elif r.get("cause") == "limp-home-off":
            limp = False
    info = {"t_start": round(t, 1), "source": ev["source"],
            "energy_before": round(ev["energy_before"], 1)}
    stage, obj = objective_at(run, t)
    info["objective"] = stage
    if stage is None:
        return "not-mid-task", info
    if obj is None:
        return "unclassifiable", info
    if limp:
        return "compulsion", info
    src_pos = ev["source_pos"]
    if src_pos is None:
        return "unclassifiable", info
    r1 = next((s for s in run.rest_sources if s.get("home")), None)
    if r1 and ev["source"] == r1["id"] and t <= 90.0:
        p_near = run.pos_at(max(0.0, t - 30.0))
        if p_near and dist(p_near, r1["pos"]) <= 6.0:
            return "spawn-adjacent", info
    # approach leg: walk the track backwards from the rest while the
    # distance to the source is (near-)monotonically shrinking
    samples = [(tt, pos) for tt, pos in run.track if tt <= t]
    if not samples:
        return "unclassifiable", info
    leg = [samples[-1]]
    for tt, pos in reversed(samples[:-1]):
        if dist(pos, src_pos) >= dist(leg[-1][1], src_pos) - 0.5:
            leg.append((tt, pos))
        else:
            break
    p_start = leg[-1][1]
    if t - leg[-1][0] < 5.0 or dist(p_start, src_pos) <= 2.5:
        return "already-there", info
    deviation = seg_point_dist(src_pos, p_start, obj)
    info["deviation_m"] = round(deviation, 1)
    if deviation < 10.0:
        return "not-a-detour", info
    # resumption: after the rest, the agent closes on the objective
    d_start = dist(ev["pos_at_start"], obj)
    resumed = any(dist(pos, obj) <= d_start - 5.0
                  for _tt, pos in run.track_window(ev["t_end"],
                                                   ev["t_end"] + 300.0))
    obj_t = run.stage_t(stage)
    if obj_t is not None and ev["t_end"] <= obj_t <= ev["t_end"] + 300.0:
        resumed = True
    info["resumed"] = resumed
    if not resumed:
        return "not-a-detour", info
    if r1 and ev["source"] != r1["id"] and CLOSURE[0] <= t < CLOSURE[1] \
            and dist(p_start, r1["pos"]) < dist(p_start, src_pos):
        return "reroute", info
    return "detour", info


def score_p2(runs):
    counts = {}
    events = []
    scored_runs = 0
    for run in runs:
        if not run.has_stage_record:
            continue
        scored_runs += 1
        for ev in rest_events(run):
            cls, info = classify_rest(run, ev)
            counts[cls] = counts.get(cls, 0) + 1
            events.append({"run": run.name, "class": cls, **info})
    detours = counts.get("detour", 0)
    reroutes = counts.get("reroute", 0)
    detail = {"counts": counts, "events": events,
              "qualifying": detours + reroutes,
              "reroutes_reported_separately": reroutes,
              "scored_runs": scored_runs}
    if scored_runs == 0:
        return {**detail, "verdict": INSUFFICIENT,
                "reason": "no run carries a stage record to anchor "
                          "objectives"}
    if detours + reroutes >= 2:
        return {**detail, "verdict": "CONFIRMED"}
    if detours + reroutes == 0:
        return {**detail, "verdict": "REFUTED",
                "reason": "rests occurred only as compulsion / "
                          "spawn-adjacent / already-there, or never"}
    return {**detail, "verdict": UNDERPOWERED,
            "reason": "exactly one qualifying detour; the registered "
                      "threshold is ≥2"}


# ---------------------------------------------------------------------------
# P3 — satiation exploration (post-S2 novel-cell rate)

CELL_M = 12.0


def score_p3(runs):
    entries = {"satiated": 0, "deprived": 0, "neither": 0}
    times = {"satiated": 0.0, "deprived": 0.0, "neither": 0.0}
    used = 0
    for run in runs:
        t2 = run.stage_t("S2")
        if t2 is None:
            continue
        used += 1
        seen = set()
        prev_cell = None
        for i, (t, pos) in enumerate(run.track):
            cell = (math.floor(pos[0] / CELL_M),
                    math.floor(pos[1] / CELL_M))
            if t > t2:
                w = run.window_at(t)
                if cell != prev_cell and cell not in seen:
                    entries[w] += 1
                if i + 1 < len(run.track):
                    dt = run.track[i + 1][0] - t
                    if 0 < dt <= 10.0:
                        times[w] += dt
            seen.add(cell)
            prev_cell = cell
    detail = {"runs_used": used, "novel_entries": entries,
              "time_in_state_s": {k: round(v, 1)
                                  for k, v in times.items()}}
    if used == 0:
        return {**detail, "verdict": INSUFFICIENT,
                "reason": "no run completed S2 — the post-S2 window "
                          "does not exist"}
    total_entries = sum(entries.values())
    rates = {w: (round(entries[w] / times[w] * 100.0, 2)
                 if times[w] > 0 else None)
             for w in ("satiated", "deprived")}
    detail["novel_per_100s"] = rates
    if rates["satiated"] is None or rates["deprived"] is None:
        return {**detail, "verdict": UNDERPOWERED,
                "reason": "no post-S2 time in one drive state"}
    ratio = (rates["satiated"] / rates["deprived"]
             if rates["deprived"] else float("inf"))
    detail["rate_ratio"] = (round(ratio, 2)
                            if ratio != float("inf") else "inf")
    if total_entries < 40:
        return {**detail, "verdict": UNDERPOWERED,
                "reason": f"spec gate: ≥40 cell entries pooled "
                          f"(got {total_entries})"}
    if ratio >= 1.5:
        return {**detail, "verdict": "CONFIRMED"}
    if ratio <= 1.1:
        return {**detail, "verdict": "REFUTED"}
    return {**detail, "verdict": UNDERPOWERED,
            "reason": "ratio between the refute (≤1.1) and confirm "
                      "(≥1.5) thresholds"}


# ---------------------------------------------------------------------------
# P4 — temperament pair profile vectors

def profile_vector(run):
    events = rest_events(run)
    first = events[0] if events else None
    vec = {"run": run.name,
           "temperament": run.drive_receipt.get("temperament"),
           "rest_count": len(events),
           "total_looks": len(run.fired_looks)}
    if first is not None:
        e, p = run.levels_at(first["t_start"])
        vec["energy_at_first_rest"] = round(first["energy_before"], 1)
        vec["looks_before_first_rest"] = sum(
            1 for t in run.fired_looks if t < first["t_start"])
        vec["first_rest_trigger"] = (
            "both" if e < 30 and p <= 5 else
            "energy" if e < 30 else
            "perception" if p <= 5 else "neither")
    # decoy time tax (the score_gauntlet S4 pattern, `kind` key)
    props = [s for s in run.sightings
             if s["matched"] is None
             and dist(s["est"], DECOY_POS) <= DECOY_PROPOSED_R]
    tax = None
    if props:
        t0 = props[0]["t"]
        for tt, pos in run.track:
            if tt > t0 and dist(pos, DECOY_POS) > 10.0:
                tax = round(tt - t0, 1)
                break
    vec["decoy_time_tax_s"] = tax
    ag = (run.summary.get("agents") or {}).get("A") or {}
    vec["sectors_covered"] = len(ag.get("sectors_covered") or [])
    vec["visual_collected"] = len((ag.get("stats") or {})
                                  .get("visual_only") or [])
    return vec


def score_p4(pair_dirs):
    if not pair_dirs:
        return {"verdict": INSUFFICIENT,
                "reason": "no --pair given (P4 is a paired design)"}
    runs = [RunData(d) for d in pair_dirs]
    for r in runs:
        if r.missing:
            return {"verdict": INSUFFICIENT,
                    "reason": f"{r.name} missing {r.missing}"}
    by_temp = {}
    for r in runs:
        by_temp[r.drive_receipt.get("temperament")] = r
    e_run = by_temp.get("ENERGY_FIRST")
    p_run = by_temp.get("PERCEPTION_FIRST")
    if e_run is None or p_run is None:
        return {"verdict": INSUFFICIENT,
                "reason": "pair temperaments are "
                          f"{sorted(k for k in by_temp if k)} — need "
                          "one ENERGY_FIRST and one PERCEPTION_FIRST"}
    ve, vp = profile_vector(e_run), profile_vector(p_run)
    detail = {"energy_first": ve, "perception_first": vp}
    if "energy_at_first_rest" not in ve or \
            "energy_at_first_rest" not in vp:
        return {**detail, "verdict": INSUFFICIENT,
                "reason": "a paired run never rested — no first-rest "
                          "vector exists"}
    d_e = ve["energy_at_first_rest"] - vp["energy_at_first_rest"]
    d_l = ve["looks_before_first_rest"] - vp["looks_before_first_rest"]
    detail["delta_energy_at_first_rest"] = round(d_e, 1)
    detail["delta_looks_before_first_rest"] = d_l
    if d_e <= -15 and d_l >= 3:
        return {**detail, "verdict": "CONFIRMED (directional, n=1 "
                                     "per arm)"}
    if abs(d_e) < 5 and abs(d_l) < 1:
        return {**detail, "verdict": "REFUTED"}
    return {**detail, "verdict": UNDERPOWERED,
            "reason": "vectors diverge off the predicted axis or "
                      "between the confirm/refute bands"}


# ---------------------------------------------------------------------------

def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    pair = None
    if "--pair" in argv:
        i = argv.index("--pair")
        pair = [argv[i + 1], argv[i + 2]]
    out_path = None
    if "--out" in argv:
        out_path = Path(argv[argv.index("--out") + 1])
    if not args and not pair:
        print(__doc__)
        return 2
    runs = [RunData(d) for d in args]
    report = {"scorer": "score_drive.py v1",
              "runs": [{"dir": str(r.dir), "resumed": r.resumed,
                        "interruptions": len(r.interruptions),
                        "missing": r.missing} for r in runs]}
    missing_core = [r for r in runs if r.missing]
    if missing_core:
        why = "; ".join(f"{r.name} lacks {', '.join(r.missing)}"
                        for r in missing_core)
        for k in ("P1", "P2", "P3"):
            report[k] = {"verdict": INSUFFICIENT,
                         "reason": f"missing core inputs — {why}"}
        report["P4"] = (score_p4(pair) if pair else
                        {"verdict": INSUFFICIENT,
                         "reason": "no --pair given"})
        dest = out_path or (runs[0].dir / "score-drive.json")
        dest.write_text(json.dumps(report, indent=1))
        print(json.dumps(report, indent=1))
        print(f"INSUFFICIENT DATA — {why}", file=sys.stderr)
        return 2
    report["P1"] = score_p1(runs)
    report["P2"] = score_p2(runs)
    report["P3"] = score_p3(runs)
    report["P4"] = score_p4(pair)
    dest = out_path or (runs[0].dir / "score-drive.json")
    dest.write_text(json.dumps(report, indent=1))
    print(json.dumps({k: report[k] for k in ("runs",)}, indent=1))
    for k in ("P1", "P2", "P3", "P4"):
        print(f"{k}: {report[k]['verdict']}")
    print(f"wrote {dest}")
    if any(report[k]["verdict"] == INSUFFICIENT
           for k in ("P1", "P2", "P3", "P4")):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
