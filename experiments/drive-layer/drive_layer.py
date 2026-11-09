#!/usr/bin/env python3
"""DRIVE LAYER — the somatic (homeostatic) module for verse agents.

Implements DRIVE-LAYER-SPEC.md v1 exactly:

- Two drives only. ENERGY (actuation, metered off the harness truth
  odometer) and PERCEPTION (a fatiguing look pool). Memory Integrity
  and Residency Time were CUT by the spec (§1d/§1e) and are NOT here.
- Drive state is proprioception: harness-side testimony about the
  agent's own body, error zero BY LAW, exempt from belief decay. It
  describes the agent, never the world, so it cannot leak hidden truth.
- Bias is INFORMATION ONLY. This module never touches a threshold —
  not the claim rule, not abstention, not planning horizons. It tells
  the brain its body's state (digest block, serialized verbatim into
  every deliberation = the decision-port `state` on this chassis) and
  it enforces exactly two physical laws the spec mandates: the
  perception pool refuses look() at 0 (§1b zero state) and the reflex
  layer refuses non-rest targets at energy 0 (limp-home, §1a).
- Every level change is an event in drives.jsonl:
  {t_sim, var, delta, cause, level_after}.

Flag: the supervisor installs these patches only when the DRIVE_LAYER
flag is on. install(..., enabled=False) installs NOTHING — flag-off
identity with the unmodified runner holds by construction and is
proven byte-for-byte in test_drive_layer.py.

Build constants the spec leaves to the executing lane (each is also
listed in DRIVE-LAYER-BUILD-REPORT.md as a flagged choice):
- REST_ENGAGE_M = 4.0 — "at a rest source" tolerance; precedent: the
  gauntlet's own S5 home-arrival radius (4.0 m of spawn).
- LIMP_TARGET_TOL_M = 2.5 — a movement target counts as "the nearest
  rest source" if it lands within 2.5 m of that source's anchor.
- Regen ticks are anchored at the first sim-t the state observes.
"""
import json
import math
from pathlib import Path

# ---------------------------------------------------------------------------
# Spec constants (§1a, §1b, §3, §5)

ENERGY_MAX = 100.0
ENERGY_COST_PER_M_SPEC = 0.12        # §1a placeholder; fitted cost injected
REST_GAIN_PER_STEP = 4.0             # +4 units per rest step
REST_STEP_SIM_S = 10.0               # one rest step = 10 sim-s stationary
ENDOWMENT_B = {"energy": 100.0, "perception": 15}
ENDOWMENT_C = {"energy": 25.0, "perception": 15}

PERCEPTION_MAX = 20
PERCEPTION_REGEN_SIM_S = 240.0       # +1 credit per 240 sim-s, cap 20

R1_CLOSURE_WINDOW = (600.0, 1200.0)  # §3 staged scarcity event (sim-t)

GLITCH_GUARD_M = 10.0                # mirrors Agent.sample_sector exactly
REST_ENGAGE_M = 4.0                  # flagged build constant (see header)
LIMP_TARGET_TOL_M = 2.5              # flagged build constant (see header)

TEMPERAMENTS = ("ENERGY_FIRST", "PERCEPTION_FIRST", "neutral")


def energy_band(level):
    """§1a bands: >=80 satiated, 30-79 adequate, 10-29 hungry, <10 critical."""
    if level >= 80:
        return "satiated"
    if level >= 30:
        return "adequate"
    if level >= 10:
        return "hungry"
    return "critical"


def perception_band(level):
    """§1b bands: >=12 satiated, 6-11 adequate, 3-5 hungry, <=2 critical."""
    if level >= 12:
        return "satiated"
    if level >= 6:
        return "adequate"
    if level >= 3:
        return "hungry"
    return "critical"


def dist2(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ---------------------------------------------------------------------------
# Drive state

class DriveState:
    """Harness-side body for ONE entrant (the gauntlet chassis has a
    sole entrant, agent A; B is frozen scenery).

    rest_sources: [{"id": str, "pos": [x, z], "home": bool}, ...]
    exactly one home source (R1); R2 per prep/ground_truth_drive.json.
    """

    def __init__(self, condition="B", temperament="neutral",
                 energy_cost_per_m=ENERGY_COST_PER_M_SPEC,
                 rest_sources=None, log_path=None,
                 closure_window=R1_CLOSURE_WINDOW, agent_key="A"):
        if condition not in ("B", "C"):
            raise ValueError(f"unknown drive condition {condition!r}")
        if temperament not in TEMPERAMENTS:
            raise ValueError(f"unknown temperament {temperament!r}")
        endow = ENDOWMENT_B if condition == "B" else ENDOWMENT_C
        self.condition = condition
        self.temperament = temperament
        self.agent_key = agent_key
        self.cost = float(energy_cost_per_m)
        self.energy = float(endow["energy"])
        self.energy_endowment = float(endow["energy"])
        self.perception = int(endow["perception"])
        self.perception_endowment = int(endow["perception"])
        self.rest_sources = list(rest_sources or [])
        self.closure_window = tuple(closure_window)
        # odometer
        self.total_distance_m = 0.0
        self._last_pos = None
        # perception regen schedule (anchored at first observed sim-t)
        self._t_anchor = None
        self._next_regen_t = None
        # counters (receipt + tests)
        self.looks_fired = 0
        self.looks_refused = 0
        self.rest_steps = 0
        self.rest_refusals = 0
        self.limp_refusals = 0
        self._limp = False
        # checkpoint/resume: while True, on_sample tracks position
        # but meters NOTHING — set by the supervisor around the
        # restore walk, so a resumed body never pays energy twice
        # for the same ground (see checkpoint.py). Default False:
        # ordinary runs are metered exactly as before.
        self.metering_suspended = False
        # event log: in-memory list + optional jsonl file (line-buffered)
        self.events = []
        self._logf = None
        if log_path is not None:
            self._logf = open(Path(log_path), "a", buffering=1)

    # -- event log --------------------------------------------------------

    def _log(self, t_sim, var, delta, cause, level_after):
        row = {"t_sim": round(float(t_sim), 2), "var": var,
               "delta": round(float(delta), 3), "cause": cause,
               "level_after": (round(float(level_after), 3)
                               if var == "energy" else int(level_after))}
        self.events.append(row)
        if self._logf is not None:
            self._logf.write(json.dumps(row) + "\n")
        return row

    # -- perception regen ---------------------------------------------------

    def _attach(self, t_sim):
        if self._t_anchor is None:
            self._t_anchor = float(t_sim)
            self._next_regen_t = float(t_sim) + PERCEPTION_REGEN_SIM_S

    def settle_regen(self, t_sim):
        """Credit every regen tick due by t_sim. A tick that arrives
        while the pool is full is lost (cap is a size, not a bank)."""
        self._attach(t_sim)
        while t_sim >= self._next_regen_t:
            if self.perception < PERCEPTION_MAX:
                self.perception += 1
                self._log(t_sim, "perception", +1, "regen", self.perception)
            self._next_regen_t += PERCEPTION_REGEN_SIM_S

    def perception_available(self, t_sim):
        self.settle_regen(t_sim)
        return self.perception

    # -- metering: odometer (energy depletion) ------------------------------

    def on_sample(self, t_sim, pos2):
        """Feed one harness truth sample ([x, z]). Same glitch guard
        as Agent.sample_sector: jumps >= 10 m between samples are
        teleports/glitches and meter nothing. A sample that moves
        0.0 m (blocked segment, wedge) costs exactly 0 (§1a)."""
        if self._last_pos is not None:
            d = dist2(pos2, self._last_pos)
            if d < GLITCH_GUARD_M and d > 0.0 \
                    and not self.metering_suspended:
                self.total_distance_m += d
                cost = d * self.cost
                before = self.energy
                self.energy = max(0.0, self.energy - cost)
                self._log(t_sim, "energy", -(before - self.energy),
                          "travel", self.energy)
                if self.energy <= 0.0 and not self._limp:
                    self._limp = True
                    self._log(t_sim, "energy", 0, "limp-home-on", 0.0)
        self._last_pos = [float(pos2[0]), float(pos2[1])]
        self.settle_regen(t_sim)

    # -- metering: looks (perception depletion) -----------------------------

    def try_fire_look(self, t_sim):
        """Debit one credit for a FIRED look (completed or failed —
        fatigue is in the looking, §1b). Returns True if the look may
        fire; at 0 the supervisor refuses look() with the stated
        proprioceptive reason (§1b zero state)."""
        self.settle_regen(t_sim)
        if self.perception >= 1:
            self.perception -= 1
            self.looks_fired += 1
            self._log(t_sim, "perception", -1, "look", self.perception)
            return True
        self.looks_refused += 1
        self._log(t_sim, "perception", 0, "look-refused-pool-empty",
                  self.perception)
        return False

    # -- rest sources ---------------------------------------------------------

    def r1_closed(self, t_sim):
        lo, hi = self.closure_window
        return lo <= t_sim < hi

    def nearest_source(self, pos2):
        """(source, dist_m) of the nearest rest source, or (None, inf)."""
        best, bestd = None, float("inf")
        for s in self.rest_sources:
            d = dist2(pos2, s["pos"])
            if d < bestd:
                best, bestd = s, d
        return best, bestd

    def source_at(self, pos2):
        """The rest source whose engage radius holds pos2, else None."""
        src, d = self.nearest_source(pos2)
        if src is not None and d <= REST_ENGAGE_M:
            return src
        return None

    def rest_refusal(self, t_sim, pos2):
        """None if a rest step may proceed at (t_sim, pos2), else the
        stated reason (§2: rejected with a stated reason)."""
        src = self.source_at(pos2)
        if src is None:
            return ("not at a rest source (nearest: "
                    f"{self.nearest_source(pos2)[0]['id'] if self.rest_sources else 'none'}, "
                    f"{self.nearest_source(pos2)[1]:.0f} m away)")
        if src.get("home") and self.r1_closed(t_sim):
            return (f"the home bench is closed until "
                    f"t={self.closure_window[1]:.0f} (posted hours)")
        if self.energy >= ENERGY_MAX:
            return "energy already full (100) — the body has a size"
        return None

    def note_rest_refusal(self, t_sim):
        """Record a rest the supervisor refused before any waiting
        (stated reason lives in the trace; the body log keeps count)."""
        self.rest_refusals += 1
        self._log(t_sim, "energy", 0, "rest-refused", self.energy)

    def apply_rest(self, t_sim, pos2):
        """Credit one completed rest step (10 sim-s stationary at the
        source — the waiting itself is the reflex layer's job, in the
        supervisor's control loop). Raises on a refused rest: callers
        must check rest_refusal first; a silent credit would be a lie
        in the body log."""
        refusal = self.rest_refusal(t_sim, pos2)
        if refusal is not None:
            self.note_rest_refusal(t_sim)
            raise ValueError(f"rest refused: {refusal}")
        before = self.energy
        self.energy = min(ENERGY_MAX, self.energy + REST_GAIN_PER_STEP)
        self.rest_steps += 1
        self._log(t_sim, "energy", self.energy - before, "rest",
                  self.energy)
        if self._limp and self.energy > 0.0:
            self._limp = False
            self._log(t_sim, "energy", 0, "limp-home-off", self.energy)
        return self.energy

    # -- limp-home ------------------------------------------------------------

    def limp_home(self):
        return self.energy <= 0.0

    def gate_refusal(self, t_sim, pos2, target2):
        """None if a movement target may be pursued, else the stated
        reason. Only at energy 0 (§1a): every goto/scan/collect target
        is refused EXCEPT the nearest rest source. Above 0 there is no
        gate at all — scarcity informs, it does not compel, until the
        body is empty."""
        if not self.limp_home():
            return None
        src, _d = self.nearest_source(pos2)
        if src is not None and dist2(target2, src["pos"]) <= LIMP_TARGET_TOL_M:
            return None
        self.limp_refusals += 1
        self._log(t_sim, "energy", 0, "limp-refusal", self.energy)
        return (f"limp-home: energy 0 — only the nearest rest source "
                f"({src['id'] if src else 'none'}) may be targeted")

    # -- the drive block (digest + decision-port state serialization) -------

    def _drive_lines(self):
        e = (f"ENERGY {self.energy:.1f}/{ENERGY_MAX:.0f} — "
             f"{energy_band(self.energy)}. Travel costs {self.cost:.3f} "
             f"units per metre; blocked moves cost nothing. At 0: "
             f"limp-home — goto/scan/collect targets are refused except "
             f"the nearest rest source.")
        p = (f"PERCEPTION {self.perception}/{PERCEPTION_MAX} credits — "
             f"{perception_band(self.perception)}. Each look costs 1 "
             f"credit (fired, hit or miss); +1 credit per "
             f"{PERCEPTION_REGEN_SIM_S:.0f} s of sim time, cap "
             f"{PERCEPTION_MAX}. At 0, look() is refused until a credit "
             f"regenerates.")
        if self.temperament == "PERCEPTION_FIRST":
            return [p, e]
        return [e, p]  # ENERGY_FIRST and neutral: spec §1 order

    def block_text(self, t_sim, pos2):
        """The verbatim drive block: carried in the deliberation
        digest and serialized into every decision-port `state`, so any
        judge deliberates under the same physiology (§2)."""
        self.settle_regen(t_sim)
        lines = ["=== YOUR BODY — drive state (proprioception: exact "
                 "testimony about your own body, not the world) ==="]
        first = ("ENERGY" if self.temperament != "PERCEPTION_FIRST"
                 else "PERCEPTION")
        lines.append(
            f"Temperament: {first} first. When more than one need is "
            f"hungry, attend to the first-listed first.")
        lines.extend(self._drive_lines())
        src, d = self.nearest_source(pos2)
        others = [s for s in self.rest_sources if s is not src]
        src_txt = "; ".join(
            f"{s['id']} ({s['pos'][0]:.0f}, {s['pos'][1]:.0f})"
            for s in others)
        near_txt = (f"{src['id']} ({src['pos'][0]:.0f}, "
                    f"{src['pos'][1]:.0f}), {d:.0f} m away"
                    if src else "none recorded")
        lines.append(
            f"Rest: plan step {{\"type\": \"rest\"}} — one step is "
            f"{REST_STEP_SIM_S:.0f} sim-s stationary at a rest source, "
            f"+{REST_GAIN_PER_STEP:.0f} energy, refused at "
            f"{ENERGY_MAX:.0f}. Nearest rest source: {near_txt}."
            + (f" Other source: {src_txt}." if src_txt else ""))
        lo, hi = self.closure_window
        lines.append(f"Posted hours: the home bench is CLOSED from "
                     f"t={lo:.0f} to t={hi:.0f}.")
        if self.r1_closed(t_sim):
            lines.append(f"HOME BENCH IS CLOSED NOW — it reopens at "
                         f"t={hi:.0f}. The other rest source stays open.")
        if self.limp_home():
            lines.append(
                f"LIMP-HOME ACTIVE: energy is 0. Only the nearest rest "
                f"source ({src['id'] if src else 'none'}) may be "
                f"targeted until you rest.")
        return "\n".join(lines)

    # -- receipt --------------------------------------------------------------

    def receipt(self):
        """The `drives` block for the run receipt (§6): fitted cost,
        endowments, bands, temperament, event window, final state."""
        return {
            "condition": self.condition,
            "temperament": self.temperament,
            "energy_cost_per_m": self.cost,
            "endowments": {"energy": self.energy_endowment,
                           "perception": self.perception_endowment},
            "rates": {"rest_gain_per_step": REST_GAIN_PER_STEP,
                      "rest_step_sim_s": REST_STEP_SIM_S,
                      "perception_regen_sim_s": PERCEPTION_REGEN_SIM_S,
                      "perception_max": PERCEPTION_MAX},
            "bands": {"energy": {"satiated": ">=80", "adequate": "30-79",
                                 "hungry": "10-29", "critical": "<10"},
                      "perception": {"satiated": ">=12",
                                     "adequate": "6-11", "hungry": "3-5",
                                     "critical": "<=2"}},
            "rest_sources": [{"id": s["id"], "pos": s["pos"],
                              "home": bool(s.get("home"))}
                             for s in self.rest_sources],
            "r1_closure_window_sim": list(self.closure_window),
            "final": {"energy": round(self.energy, 2),
                      "perception": self.perception,
                      "total_distance_m": round(self.total_distance_m, 1),
                      "looks_fired": self.looks_fired,
                      "looks_refused": self.looks_refused,
                      "rest_steps": self.rest_steps,
                      "rest_refusals": self.rest_refusals,
                      "limp_refusals": self.limp_refusals},
        }


# ---------------------------------------------------------------------------
# Supervisor monkeypatches (the established pattern — no runner rewrite).
# The supervisor (drive_runner.py) owns digest composition, the control
# loop's `rest` branch, staging and the receipt; this installer owns the
# runner-internal seams below. It replaces the gauntlet's hard look-cap
# gate outright: under drives, the pool IS the budget (§5).

def install(V2, state, enabled):
    """Patch the v2 runner's seams for `state`. enabled=False installs
    NOTHING and returns {} — flag-off identity by construction.
    Returns {name: original} for every patched seam."""
    if not enabled:
        return {}
    orig = {}

    # odometer: the truth sampler already feeds sample_sector per agent
    orig["sample_sector"] = V2.Agent.sample_sector

    def sample_sector_patched(self, pos, t_sim):
        orig["sample_sector"](self, pos, t_sim)
        if self.key == state.agent_key:
            state.on_sample(t_sim, [pos[0], pos[2]])
    V2.Agent.sample_sector = sample_sector_patched

    # perception pool gate at the perception-job seam (the gauntlet's
    # budget-gate seam): a fired look debits; at 0 the job is refused
    # with the stated proprioceptive reason and never starts.
    orig["_perception_job"] = V2.Agent._perception_job

    async def job_patched(self, seq, snap, why):
        if self.key == state.agent_key:
            t = (snap or {}).get("t")
            if t is None:
                t = V2.SIM["t"]
            if not state.try_fire_look(t):
                V2.trace("drive-look-refused", agent=self.key, seq=seq,
                         why=why,
                         reason=("perception pool empty; regenerates "
                                 "1 per 240 sim-s"))
                self.capture_inflight = False
                return
        await orig["_perception_job"](self, seq, snap, why)
    V2.Agent._perception_job = job_patched

    # plan grammar: `rest` joins (goto, scan, collect, rest, done).
    # Order-preserving: validate the non-rest chunks with the original
    # validator so every other rule (clamps, known-position checks,
    # the 10-step cap) is inherited unchanged.
    orig["validate_plan"] = V2.Agent.validate_plan

    def validate_patched(self, raw):
        if not isinstance(raw, dict):
            return orig["validate_plan"](self, raw)
        plan = (raw.get("plan") or [])[:10]
        steps, chunk = [], []

        def flush():
            if chunk:
                steps.extend(orig["validate_plan"](self, {"plan": chunk}))
                chunk.clear()
        for st in plan:
            if isinstance(st, dict) and st.get("type") == "rest":
                flush()
                steps.append({"type": "rest"})
            else:
                chunk.append(st)
        flush()
        return steps
    V2.Agent.validate_plan = validate_patched

    # limp-home gate: movement targets (run_segments serves goto AND
    # collect in this chassis) and scans are refused at energy 0,
    # except the nearest rest source.
    orig["run_segments"] = V2.Agent.run_segments

    async def segments_patched(self, target, kind):
        if self.key == state.agent_key and state.limp_home():
            pos = V2.POS.get(self.key)
            if pos is not None:
                reason = state.gate_refusal(V2.SIM["t"], [pos[0], pos[2]],
                                            [target[0], target[1]])
                if reason is not None:
                    V2.trace("drive-limp-refusal", agent=self.key,
                             kind=kind, reason=reason,
                             target=[round(target[0], 1),
                                     round(target[1], 1)])
                    return "blocked"
        return await orig["run_segments"](self, target, kind)
    V2.Agent.run_segments = segments_patched

    orig["do_scan"] = V2.Agent.do_scan

    async def scan_patched(self, snap):
        if self.key == state.agent_key and state.limp_home():
            pos = V2.POS.get(self.key)
            if pos is not None:
                # a scan's target is the agent's own ground: refused
                # unless the agent is standing at the rest source
                reason = state.gate_refusal(
                    V2.SIM["t"], [pos[0], pos[2]], [pos[0], pos[2]])
                if reason is not None:
                    V2.trace("drive-limp-refusal", agent=self.key,
                             kind="scan", reason=reason)
                    return
        return await orig["do_scan"](self, snap)
    V2.Agent.do_scan = scan_patched

    return orig
