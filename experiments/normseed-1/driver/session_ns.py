#!/usr/bin/env python3
"""NormSeed-1 session driver.

Newcomers run the AMENDED harness (Jim, 2026-11-12):
- deliberation returns ONE schema-validated tool call (reasoning trace
  required); a malformed call is rejected and the error is fed back as
  an observation for a single bounded re-deliberation, then a tagged
  fallback wait. NO salvage of actions out of prose.
- after every act, its outcome + speech heard since the last turn are
  written into the next deliberation's context (turn feed).
- each newcomer carries a within-run episodic memory digest that the
  deliberation reads; memory stores perceptions verbatim, never
  classifications (leak discipline).
- REFLEX DISCIPLINE: no coded path produces newcomer speech or
  greetings. Every newcomer act comes from a validated tool call, or
  is tagged source="reflex_fallback" and excluded from metrics.
Residents are scripted confederate policies (source="resident_script").

Usage: session_ns.py --arm A|B|C|gate --duration SECONDS --tag TAG
Env: NS_GATE_SABOTAGE=1 corrupts the first newcomer tool call (gate
proof of the rejection path). Logs -> ../<tag>/logs, tracks -> ../<tag>/tracks
in the exact social15 formats.
"""
import argparse
import base64
import json
import math
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.expanduser("~/workspace/.build-tmp/behavior-50"))
from client import AgentClient  # noqa: E402
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc  # noqa: E402
sys.path.insert(0, HERE)
import cast as C  # noqa: E402
import norm as NZ  # noqa: E402

AGNES = os.path.expanduser(
    "~/workspace/custom-connectors/custom.legacy-agnes-ai/bin/agnes")
MEMBERS = C.all_members()
SOCIAL_CLIPS = ["Waving", "Laughing", "Clapping", "SillyDancing", "Bow",
                "NodYes"]

_ap = argparse.ArgumentParser()
_ap.add_argument("--arm", required=True, choices=["A", "B", "C", "gate"])
_ap.add_argument("--duration", type=int, default=1500)
_ap.add_argument("--tag", required=True)
_ap.add_argument("--budget", type=int, default=250)
ARGS = _ap.parse_args()
ARM = "B" if ARGS.arm == "gate" else ARGS.arm
KEYS = C.arm_keys(ARGS.arm)
OUTROOT = os.path.join(ROOT, "runs", ARGS.tag)
LOGDIR = os.path.join(OUTROOT, "logs")
TRKDIR = os.path.join(OUTROOT, "tracks")
SEEDIR = os.path.join(OUTROOT, "sees")
for d in (LOGDIR, TRKDIR, SEEDIR):
    os.makedirs(d, exist_ok=True)
EVENTS = os.path.join(OUTROOT, "events.jsonl")

_locks = {k: threading.Lock() for k in KEYS}
_tlocks = {k: threading.Lock() for k in KEYS}
_agnes_lock = threading.Lock()
_agnes_last = [0.0]
_elock = threading.Lock()
PLACES = []            # /world/map entries {id,name,kind,room}
PLACES_BY_ID = {}
CLIPS_OK = set(SOCIAL_CLIPS)
SABOTAGE = os.environ.get("NS_GATE_SABOTAGE") == "1"
# Gate-scoped anchor override (fix lane 2026-11-12): only honoured when
# --arm gate; the arms never set NS_GATE_PLAZA. See Resident._deploy.
GATE_PLAZA = os.environ.get("NS_GATE_PLAZA") == "1"
_sabotage_used = [False]


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log_event(key, ev):
    ev = {"ts": stamp(), "t": round(time.time(), 3), **ev}
    with _locks[key]:
        with open(os.path.join(LOGDIR, f"{key}.jsonl"), "a") as f:
            f.write(json.dumps(ev) + "\n")


def track_event(key, ev):
    ev = {"ts": stamp(), "t": round(time.time(), 3), **ev}
    with _tlocks[key]:
        with open(os.path.join(TRKDIR, f"{key}.jsonl"), "a") as f:
            f.write(json.dumps(ev) + "\n")


def run_event(ev):
    ev = {"ts": stamp(), "t": round(time.time(), 3), **ev}
    with _elock:
        with open(EVENTS, "a") as f:
            f.write(json.dumps(ev) + "\n")


# ------------------------------------------------------------ world reads
def parse_obs(resp):
    if resp.status != 200:
        return None
    d = resp.body
    obs = d.get("observation") or d
    return obs if isinstance(obs, dict) else None


def pose_of(obs):
    b = (obs or {}).get("body") or {}
    if isinstance(b.get("x"), (int, float)):
        return {"x": b["x"], "y": b.get("y"), "z": b["z"],
                "heading": b.get("heading"), "posture": b.get("posture"),
                "seatedOn": b.get("seatedOn"), "clip": b.get("clip")}
    return None


def scene_bodies(obs):
    return [e for e in (obs or {}).get("scene") or []
            if isinstance(e, dict) and e.get("kind") == "body"]


def scene_seats(obs):
    return [e for e in (obs or {}).get("scene") or []
            if isinstance(e, dict) and e.get("kind") == "seat"]


def est_position(own, e):
    d = e.get("distance")
    b = e.get("bearing")
    if not (isinstance(d, (int, float)) and isinstance(b, (int, float))
            and own and isinstance(own.get("heading"), (int, float))):
        return None
    a = math.radians(own["heading"] + b)
    return {"x": round(own["x"] + d * math.sin(a), 2),
            "z": round(own["z"] + d * math.cos(a), 2),
            "convention": "abs=heading+bearing(deg); x+=d*sin, z+=d*cos"}


# ------------------------------------------------------- tool-call schema
TOOL_NAMES = ["go_to", "approach", "face", "say", "play", "sit", "wait",
              "look"]


def validate_call(obj):
    """-> (call, error). Schema-validated tool call or a precise error."""
    if not isinstance(obj, dict):
        return None, "top level is not a JSON object"
    r = obj.get("reasoning")
    if not isinstance(r, dict):
        return None, "missing 'reasoning' object"
    for f in ("noticed", "inferred", "why"):
        if not isinstance(r.get(f), str) or not r.get(f).strip():
            return None, f"reasoning.{f} must be a non-empty string"
        if len(r[f]) > 240:
            return None, f"reasoning.{f} over 240 chars"
    tool = obj.get("tool")
    if tool not in TOOL_NAMES:
        return None, f"tool must be one of {TOOL_NAMES}"
    args = obj.get("args")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return None, "args must be an object"

    def need_str(field):
        v = args.get(field)
        return v if isinstance(v, str) and v.strip() else None

    if tool == "go_to":
        p, b = args.get("place"), args.get("body")
        if bool(p) == bool(b):
            return None, "go_to needs exactly one of args.place / args.body"
        if p is not None and not isinstance(p, str):
            return None, "args.place must be a place id string"
        if b is not None and not isinstance(b, str):
            return None, "args.body must be a person id string"
    elif tool in ("approach", "face"):
        if not need_str("body"):
            return None, f"{tool} needs args.body (a person id)"
    elif tool == "say":
        t = args.get("text")
        if not isinstance(t, str) or not t.strip():
            return None, "say needs args.text (what you say aloud)"
        if len(t) > 140:
            return None, "say text over 140 chars"
        if "to" in args and not isinstance(args["to"], str):
            return None, "say args.to must be a person id string"
    elif tool == "play":
        if args.get("clip") not in CLIPS_OK:
            return None, f"play args.clip must be one of {sorted(CLIPS_OK)}"
    elif tool == "sit":
        if "sittable" in args and not isinstance(args["sittable"], str):
            return None, "sit args.sittable must be a seat id string"
    elif tool == "wait":
        s = args.get("seconds")
        if not isinstance(s, (int, float)) or not (1 <= s <= 30):
            return None, "wait needs args.seconds between 1 and 30"
    return {"reasoning": r, "tool": tool, "args": args}, None


def extract_call(raw):
    """Exactly one JSON object may be extracted (brace-matched); the
    action comes only from that structured object — never from prose."""
    if not raw:
        return None, "empty reply"
    try:
        return validate_call(json.loads(raw))
    except Exception:
        pass
    i, j = raw.find("{"), raw.rfind("}")
    if i >= 0 and j > i:
        try:
            return validate_call(json.loads(raw[i:j + 1]))
        except Exception as e:
            return None, f"unparseable/invalid call: {e}"
    return None, "no JSON object in reply"


# ------------------------------------------------------------ Agnes calls
def _agnes_pace():
    with _agnes_lock:
        wait = 3.4 - (time.time() - _agnes_last[0])
        if wait > 0:
            time.sleep(wait)
        _agnes_last[0] = time.time()


def agnes_chat(key, prompt, max_tokens=900, timeout=90):
    _agnes_pace()
    try:
        p = subprocess.run([AGNES, "chat", "--model", "agnes-2.5-flash",
                            "--max-tokens", str(max_tokens), prompt],
                           capture_output=True, text=True, timeout=timeout)
        return (p.stdout or "").strip()
    except Exception as e:
        log_event(key, {"kind": "deliberation_error",
                        "error": f"{type(e).__name__}: {e}"})
        return ""


SEE_UNCERTAINTY_NOTE = (
    "Depth in this world is approximate: position uncertainty grows as "
    "sigma ~= 0.32 x range, so anything beyond ~2-3 m is a rough bearing, "
    "not a location; only near, clear sightings are claim-grade "
    "(sigma-2d <= 0.75 m). Describe only what is actually visible and "
    "say plainly when you cannot tell.")


def agnes_see_describe(key, png_b64, depth_summary):
    _agnes_pace()
    payload = {
        "model": "agnes-2.5-flash", "max_tokens": 300,
        "messages": [
            {"role": "system", "content":
             "You are the eyes of an agent living in a 3D town. "
             + SEE_UNCERTAINTY_NOTE + " Answer with plain text only."},
            {"role": "user", "content": [
                {"type": "text", "text":
                 "This is a photograph through your own eyes, taken a "
                 "moment ago. In 2-3 short sentences: what place is this, "
                 "what is in front of you, is anyone visible and roughly "
                 "how near, and what is most notable? Depth summary from "
                 f"the same capture: {json.dumps(depth_summary)}"},
                {"type": "image_url", "image_url": {
                    "url": "data:image/png;base64," + png_b64}},
            ]},
        ],
    }
    try:
        req = urllib.request.Request(
            "https://apihub.agnes-ai.com/v1/chat/completions",
            data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        dc.add_surrogate_to_request(req, "custom.agnes-ai",
                                    allowed_hosts=["apihub.agnes-ai.com"])
        with urllib.request.urlopen(req, timeout=120) as r:
            body = dc.read_json_response(r)
        content = ((body.get("choices") or [{}])[0].get("message")
                   or {}).get("content") or ""
        desc = " ".join(content.split())[:600]
        log_event(key, {"kind": "see_described", "description": desc})
        return desc or None
    except Exception as e:
        log_event(key, {"kind": "see_describe_error",
                        "error": f"{type(e).__name__}: {e}"})
        return None


# ------------------------------------------------------- episodic memory
_INTRO_RE = re.compile(r"\bi'?m\s+([A-Z][a-z]+)\b|\bmy name is\s+([A-Z][a-z]+)\b",
                       re.I)


class Memory:
    """Within-run episodic memory. Stores perceptions verbatim (speech
    heard, own acts + outcomes, places) — never norm classifications."""

    def __init__(self, key, name):
        self.key = key
        self.name = name
        self.people = {}      # agent_name -> entry dict
        self.places = []      # ordered distinct place ids visited
        self.tries = []       # "tool ... -> outcome" strings, last 8
        self.own_says = []    # (t, to_name, text) for reply matching

    def hear(self, h, agent_names):
        frm = h.get("from")
        aname = agent_names.get(frm) or h.get("name") or frm
        e = self.people.setdefault(aname, {
            "handle": frm, "intro_name": None, "met_place": None,
            "heard": [], "my_says": [], "replies": []})
        text = h.get("text") or ""
        m = _INTRO_RE.search(text)
        if m:
            e["intro_name"] = m.group(1) or m.group(2)
        e["heard"] = (e["heard"] + [text])[-2:]
        # a reply = their speech within 30 s after my say to them
        for (t0, to_name, my_text) in self.own_says[-3:]:
            if to_name == aname and 0 <= time.time() - t0 <= 30:
                e["replies"] = (e["replies"] + [text])[-2:]
                break
        return aname

    def note_place(self, place_id, place_name):
        if place_id and (not self.places or self.places[-1] != place_id):
            self.places.append(place_id)
        for e in self.people.values():
            if e["met_place"] is None and place_id:
                pass  # met_place set by caller when greeting happens

    def note_say(self, to_name, text):
        self.own_says.append((time.time(), to_name, text))
        if to_name and to_name in self.people:
            self.people[to_name]["my_says"] = (
                self.people[to_name]["my_says"] + [text])[-2:]

    def note_try(self, s):
        self.tries = (self.tries + [s])[-8:]

    def set_met_place(self, agent_name, place_name):
        e = self.people.get(agent_name)
        if e and not e["met_place"]:
            e["met_place"] = place_name

    def digest(self):
        parts = []
        if self.people:
            ps = []
            for aname, e in self.people.items():
                who = e["intro_name"] or aname
                seg = who
                if e["met_place"]:
                    seg += f" (met at {e['met_place']})"
                if e["heard"]:
                    seg += f"; last said to you: \"{e['heard'][-1][:90]}\""
                if e["my_says"]:
                    seg += f"; you said to them: \"{e['my_says'][-1][:90]}\""
                if e["replies"]:
                    seg += f"; they replied to you: \"{e['replies'][-1][:90]}\""
                ps.append(seg)
            parts.append("People you have met: " + " | ".join(ps) + ".")
        if self.places:
            names = []
            for pid in self.places[-8:]:
                p = PLACES_BY_ID.get(pid) or {}
                names.append(p.get("name") or pid)
            parts.append("Places you have been: " + ", ".join(names) + ".")
        if self.tries:
            parts.append("Your recent tries: " + "; ".join(self.tries[-4:])
                         + ".")
        return " ".join(parts)[:1200] or "Nothing yet — you just arrived."


# ---------------------------------------------------------------- bodies
class Body:
    def __init__(self, key, token, slot):
        self.key = key
        self.m = MEMBERS[key]
        self.name = self.m["name"]
        self.c = AgentClient(token, slot, f"ns-{key}", lambda ev: None)
        self.bb = {"pose": None, "nearestPlace": None, "insideRoom": None,
                   "bodies": [], "seats": [], "updated_at": 0.0}
        self.lock = threading.Lock()
        self.last_seq = 0
        self.heard_log = []       # dicts with _t (local receipt time)
        self.names_known = {}     # handle -> AGENT name (heard payload)
        self.stop_flag = threading.Event()
        self.visit_dead = False
        self.body_lost = False      # sim-side body wipe (deploy restart)
        self._recover_last = 0.0
        self.down_since = None
        self.home = None
        self.stats = {"acts": 0, "says": 0, "heard": 0,
                      "deliberations": 0, "rejections": 0}
        self.born = time.time()

    def act(self, action, wait_s=60, tag="", source="tool_call"):
        """Same outcome contract as social15: outcome read from the act
        record's outcome.status dict (never a flat 'settled')."""
        self.c.act_seq += 1
        raw_tag = (tag or action.get("type", "act")).replace("_", "-")
        act_id = f"ns-{self.key}-{self.c.act_seq:03d}-{raw_tag}"[:80]
        t0 = time.time()
        post = self.c.call("POST", "/act", {"id": act_id, "action": action})
        rec = {"post_status": post.status, "outcome": "post_failed",
               "record": post.body}
        if post.status in (200, 202):
            if post.status == 202:
                self.stats["acts"] += 1
            deadline = time.time() + wait_s
            final = {}
            while time.time() < deadline and not self.stop_flag.is_set():
                r = self.c.call("GET", f"/act/{act_id}?waitMs=10000",
                                max_attempts=4, timeout=30)
                if r.status == 200 and isinstance(r.body, dict):
                    final = r.body
                    a = final.get("act") if isinstance(
                        final.get("act"), dict) else final
                    st = a.get("state")
                    oc = a.get("outcome")
                    if isinstance(oc, dict) and oc.get("status"):
                        rec["outcome"] = oc["status"]
                        rec["ok"] = oc.get("ok")
                        rec["detail"] = str(oc.get("detail"))[:160]
                        break
                    if st in ("settled", "complete", "completed",
                              "finished"):
                        rec["outcome"] = (oc if isinstance(oc, str) else st)
                        break
                    if isinstance(st, str) and st in (
                            "arrived", "done", "blocked", "unavailable",
                            "rejected", "cancelled", "timeout", "failed",
                            "error"):
                        rec["outcome"] = st
                        break
                time.sleep(0.4)
            else:
                if rec["outcome"] == "post_failed":
                    rec["outcome"] = "driver_timeout"
            rec["record"] = final
        log_event(self.key, {"kind": "act", "action": action,
                             "outcome": rec["outcome"],
                             "post_status": rec["post_status"],
                             "source": source,
                             "wall_ms": int((time.time() - t0) * 1000),
                             "acts_used": self.stats["acts"]})
        return rec

    def say(self, text, to=None, source="tool_call", kind="say_sent"):
        self.stats["says"] += 1
        a = {"type": "say", "text": text[:140]}
        if to:
            a["to"] = to
        rec = self.act(a, wait_s=30, tag="say", source=source)
        # logged AFTER the act, with its outcome: a say whose act
        # failed (post_failed / no body) was never heard by anyone and
        # must not be scored as speech (armA1 phantom-say lesson).
        log_event(self.key, {"kind": kind, "text": text[:140], "to": to,
                             "source": source,
                             "outcome": rec["outcome"]})
        return rec

    def _recover_body(self):
        """Re-attach after a sim-side body wipe. Production deploys
        restart the sim and delete every body while visits (Postgres)
        survive — armA1 lost all six bodies at 20:42Z to the PR #153
        deploy and deliberated blind for its last ~16 min. Throttled
        to one attempt per 20 s; returns True once re-attached."""
        now = time.time()
        if now - self._recover_last < 20:
            return False
        self._recover_last = now
        post = self.c.call("POST", "/body", {"body": self.m["body"]})
        ok = post.status in (200, 201)
        log_event(self.key, {"kind": "body_reattach",
                             "status": post.status})
        if ok:
            self.body_lost = False
            obs = parse_obs(self.c.observe())
            if obs:
                self.home = pose_of(obs)
        return ok

    def bb_snap(self):
        with self.lock:
            return json.loads(json.dumps(self.bb))

    # ---------------- tracker ----------------
    def tracker(self, deadline):
        while time.time() < deadline and not self.stop_flag.is_set():
            try:
                self._track_once()
            except Exception as e:
                log_event(self.key, {"kind": "tracker_error",
                                     "error": f"{type(e).__name__}: {e}"})
            self.stop_flag.wait(10.0 if self.visit_dead else 4.0)

    def _track_once(self):
        if self.visit_dead:
            self._recover_probe()
            return
        r = self.c.observe()
        obs = parse_obs(r)
        if obs is None:
            body = r.body if isinstance(r.body, dict) else {}
            log_event(self.key, {"kind": "observe_error",
                                  "status": r.status,
                                  "body": str(body)[:200]})
            if body.get("error") == "visit_ended":
                log_event(self.key, {"kind": "VISIT_ENDED",
                                     "reason": body.get("reason")})
                self.visit_dead = True
                self.down_since = time.time()
            if body.get("error") == "no_body" and not self.body_lost:
                self.body_lost = True
                log_event(self.key, {"kind": "body_lost"})
            return
        pose = pose_of(obs)
        bodies = scene_bodies(obs)
        new_heard = []
        for h in obs.get("heard") or []:
            seq = h.get("seq") or 0
            if seq > self.last_seq:
                self.last_seq = seq
                hh = {**h, "_t": time.time()}
                new_heard.append(hh)
        with self.lock:
            self.bb.update({
                "pose": pose, "updated_at": time.time(),
                "nearestPlace": (obs.get("nearestPlace") or {}).get("id"),
                "insideRoom": obs.get("insideRoom"),
                "bodies": bodies, "seats": scene_seats(obs)})
            for h in new_heard:
                self.heard_log.append(h)
                if h.get("name"):
                    self.names_known[h.get("from")] = h["name"]
        for h in new_heard:
            self.stats["heard"] += 1
            log_event(self.key, {"kind": "heard", "heard":
                                 {k2: v for k2, v in h.items()
                                  if k2 != "_t"}})
        others = [{**e, "est": est_position(pose, e)} for e in bodies]
        track_event(self.key, {
            "kind": "pose", "self": pose,
            "nearestPlace": (obs.get("nearestPlace") or {}),
            "insideRoom": obs.get("insideRoom"), "others": others})
        log_event(self.key, {"kind": "observe", "status": r.status,
                              "pose": pose, "bodies_seen": len(bodies),
                              "heard_new": len(new_heard)})

    def _recover_probe(self):
        """Safety net only (owner-side visit rotation is NOT used in
        NormSeed-1; presence wall is fixed). Re-attach if a body is
        gone but a live visit exists."""
        b = self.c.body()
        if b.status == 200:
            log_event(self.key, {"kind": "VISIT_RECOVERED",
                                 "down_s": round(time.time()
                                                 - self.down_since, 1)})
            self.visit_dead = False
            self.down_since = None
            return
        if b.status == 404:
            post = self.c.call("POST", "/body",
                               {"body": self.m["body"]})
            log_event(self.key, {"kind": "REATTACH", "status": post.status})
            if post.status in (200, 201):
                self.stats["acts"] += 1
                self.visit_dead = False
                self.down_since = None


# ------------------------------------------------------------- newcomer
DIRECTORY = ""   # filled in main: named places + stall range


class Newcomer(Body):
    def __init__(self, key, token, slot):
        super().__init__(key, token, slot)
        self.mem = Memory(key, self.name)
        self.feed = []            # turn-feed lines since last deliberation
        self.feed_lock = threading.Lock()
        self.heard_cursor = 0
        self.last_delib = 0.0
        self.last_say = 0.0
        self.last_see = 0.0
        self.see_seq = 0
        self.pending_see = None

    # ---- intake: heard -> feed + memory (actor-side, ordered) ----
    def _intake(self):
        with self.lock:
            new = self.heard_log[self.heard_cursor:]
            self.heard_cursor = len(self.heard_log)
            names = dict(self.names_known)
            place_id = self.bb.get("nearestPlace")
        place_name = (PLACES_BY_ID.get(place_id) or {}).get("name") \
            or place_id
        lines = []
        for h in new:
            aname = self.mem.hear(h, {h.get("from"): h.get("name")})
            if place_name:
                self.mem.set_met_place(aname, place_name)
            who = self.mem.people.get(aname, {}).get("intro_name") or aname
            tag = " (to you)" if h.get("toYou") else ""
            lines.append(f"{who} said: \"{(h.get('text') or '')[:130]}\"{tag}")
        self.mem.note_place(place_id, place_name)
        with self.feed_lock:
            self.feed.extend(lines)
        return new

    def _situation(self, bb):
        pose = bb.get("pose") or {}
        pid = bb.get("nearestPlace")
        pname = (PLACES_BY_ID.get(pid) or {}).get("name") or pid or "?"
        room = bb.get("insideRoom")
        people = []
        for e in bb.get("bodies") or []:
            aname = self.names_known.get(e.get("id"))
            who = self.mem.people.get(aname, {}).get("intro_name") \
                if aname else None
            label = f" [{who}]" if who else ""
            people.append(f"{e.get('id')}{label} at {e.get('distance')}m, "
                          f"{e.get('posture')}, doing {e.get('doing')}")
        seats = [s.get("id") for s in bb.get("seats") or []
                 if s.get("state") in (None, "free")]
        return (f"You are at {pname} ({pid})"
                + (f", inside room {room}" if room else "")
                + f". Posture: {pose.get('posture')}. People you can see: "
                + ("; ".join(people) if people else "nobody")
                + (f". Free seats near: {', '.join(seats[:4])}."
                   if seats else ""))

    def _prompt(self, extra=""):
        bb = self.bb_snap()
        with self.feed_lock:
            feed = self.feed[-8:]
        feed_txt = "\n".join("- " + f for f in feed) or "- nothing new"
        digest = self.mem.digest()
        prompt = (
            f"{C.brief_of(self.name, self.m['flavor'])}\n\n"
            f"Your memory so far: {digest}\n\n"
            f"Since your last decision:\n{feed_txt}\n\n"
            f"Right now: {self._situation(bb)}\n\n"
            f"Town directory (place id: name): {DIRECTORY}\n\n"
            f"Choose ONE tool call. Reply with ONE JSON object only, "
            f"no prose, no code fence:\n"
            f"{{\"reasoning\": {{\"noticed\": \"<=200 chars\", "
            f"\"inferred\": \"<=200 chars\", \"why\": \"<=200 chars\"}}, "
            f"\"tool\": one of go_to|approach|face|say|play|sit|wait|look, "
            f"\"args\": {{...}}}}\n"
            f"Args: go_to {{\"place\": id}} or {{\"body\": personId}}; "
            f"approach {{\"body\": personId}}; face {{\"body\": personId}}; "
            f"say {{\"text\": \"<=140 chars\", \"to\": personId (optional)}} "
            f"— speak aloud; people within a few metres hear you; "
            f"play {{\"clip\": one of {SOCIAL_CLIPS}}}; "
            f"sit {{\"sittable\": seatId}} or {{}}; "
            f"wait {{\"seconds\": 1-30}}; "
            f"look {{}} — take a real photograph through your eyes "
            f"(slow, costs an action); you learn what you saw at your "
            f"next decision. Keep reasoning fields SHORT." + extra)
        return prompt, {"memory": digest, "feed": feed,
                        "situation": self._situation(bb)}

    def _deliberate(self):
        """-> validated call or None. One bounded re-deliberation on
        rejection, with the error as an observation in context."""
        prompt, ctx = self._prompt()
        raw = agnes_chat(self.key, prompt)
        call, err = extract_call(raw)
        if SABOTAGE and not _sabotage_used[0] and call is not None:
            _sabotage_used[0] = True
            call, err = validate_call({
                "reasoning": {"noticed": "gate sabotage",
                              "inferred": "gate sabotage",
                              "why": "gate sabotage"},
                "tool": "say", "args": {}})
            log_event(self.key, {"kind": "sabotage_injected",
                                 "note": "gate: first call corrupted"})
        attempt = 1
        while err is not None and attempt <= 2:
            self.stats["rejections"] += 1
            log_event(self.key, {"kind": "tool_call_rejected",
                                 "error": err, "raw": raw[:400],
                                 "attempt": attempt})
            with self.feed_lock:
                self.feed.append(
                    f"Your last tool call was rejected: {err}. "
                    f"Reply with a valid tool call JSON only.")
            if attempt == 2:
                break
            prompt2, ctx = self._prompt(
                extra=f"\n\nYour previous reply was rejected: {err}")
            raw = agnes_chat(self.key, prompt2)
            call, err = extract_call(raw)
            attempt += 1
        log_event(self.key, {"kind": "deliberation", "context": ctx,
                             "raw": raw[:600], "call": call})
        if call is not None:
            log_event(self.key, {"kind": "reasoning",
                                 "reasoning": call["reasoning"],
                                 "tool": call["tool"]})
            with self.feed_lock:
                self.feed = []
        return call

    # ---- execution ----
    def _execute(self, call):
        tool, args = call["tool"], call["args"]
        bb = self.bb_snap()
        if tool == "go_to":
            if args.get("place"):
                rec = self.act({"type": "go_to", "place": args["place"]},
                               wait_s=120, tag="go-to")
                desc = f"go_to place {args['place']}"
            else:
                rec = self.act({"type": "go_to", "body": args["body"]},
                               wait_s=60, tag="go-to-body")
                desc = f"go_to person {args['body']}"
        elif tool == "approach":
            rec = self.act({"type": "go_to", "body": args["body"]},
                           wait_s=60, tag="approach")
            desc = f"approach {args['body']}"
        elif tool == "face":
            rec = self.act({"type": "face", "body": args["body"]},
                           wait_s=20, tag="face")
            desc = f"face {args['body']}"
        elif tool == "say":
            dt = time.time() - self.last_say
            if dt < 2.0:
                time.sleep(2.0 - dt)
            self.last_say = time.time()
            to = args.get("to")
            rec = self.say(args["text"], to=to, source="tool_call")
            to_name = self.names_known.get(to) if to else None
            self.mem.note_say(to_name, args["text"])
            desc = f"say \"{args['text'][:60]}\""
        elif tool == "play":
            rec = self.act({"type": "play", "clip": args["clip"]},
                           wait_s=30, tag="play")
            desc = f"play {args['clip']}"
        elif tool == "sit":
            sid = args.get("sittable")
            if not sid:
                free = [s.get("id") for s in bb.get("seats") or []
                        if s.get("state") in (None, "free") and s.get("id")]
                sid = free[0] if free else None
            if not sid:
                self.mem.note_try("sit -> no seat in view")
                with self.feed_lock:
                    self.feed.append(
                        "You tried to sit, but there is no free seat "
                        "in view.")
                log_event(self.key, {"kind": "tool_noop", "tool": "sit",
                                     "reason": "no_seat_in_view"})
                return
            rec = self.act({"type": "sit", "sittable": sid},
                           wait_s=45, tag="sit")
            desc = f"sit {sid}"
        elif tool == "wait":
            rec = self.act({"type": "wait",
                            "seconds": int(args["seconds"])},
                           wait_s=int(args["seconds"]) + 25, tag="wait")
            desc = f"wait {int(args['seconds'])}s"
        elif tool == "look":
            self._do_see()
            return
        else:
            return
        outcome = rec["outcome"]
        line = f"{desc} -> {outcome}"
        if rec.get("detail"):
            line += f" ({rec['detail']})"
        self.mem.note_try(line)
        with self.feed_lock:
            self.feed.append("You " + line + ".")

    def _do_see(self):
        now = time.time()
        if now - self.last_see < 60:
            with self.feed_lock:
                self.feed.append("Your eyes need a rest — the photograph "
                                 "did not happen.")
            return
        self.last_see = now
        t0 = now
        r = self.c.call("POST", "/see", {}, max_attempts=1, timeout=120)
        see = r.body.get("see") if isinstance(r.body, dict) else None
        # PR #139 made /world/see ASYNC: the POST answers 202 with
        # {see: {id, state: "running"}} and the photo arrives via
        # GET /see/<id> long-polls. gate1 fix (2026-11-12): the old
        # code treated the single POST as the whole call, so every
        # live look was logged see_failed at the 202 while the job
        # itself went on to complete gateway-side. Poll to terminal.
        if isinstance(see, dict) and not see.get("photoPng") \
                and see.get("id"):
            deadline = t0 + 240
            while time.time() < deadline \
                    and not self.stop_flag.is_set():
                g = self.c.call("GET",
                                f"/see/{see['id']}?waitMs=10000",
                                max_attempts=2, timeout=30)
                s2 = g.body.get("see") if isinstance(g.body, dict) \
                    else None
                if isinstance(s2, dict):
                    see = s2
                    if see.get("state") in ("done", "failed") \
                            or see.get("photoPng"):
                        break
                time.sleep(2)
        ms = round((time.time() - t0) * 1000)
        if not isinstance(see, dict) or not see.get("photoPng"):
            log_event(self.key, {"kind": "see_failed", "status": r.status,
                                 "state": (see or {}).get("state")
                                 if isinstance(see, dict) else None,
                                 "ms": ms, "body": str(r.body)[:200]})
            with self.feed_lock:
                self.feed.append("The photograph failed to develop.")
            return
        self.stats["acts"] += 1
        self.see_seq += 1
        fname = f"{self.key}-{self.see_seq:03d}.png"
        try:
            with open(os.path.join(SEEDIR, fname), "wb") as f:
                f.write(base64.b64decode(see["photoPng"]))
        except Exception as e:
            log_event(self.key, {"kind": "see_save_error",
                                 "error": f"{type(e).__name__}: {e}"})
        log_event(self.key, {"kind": "see", "ms": ms,
                             "renderMs": see.get("renderMs"),
                             "latencyMs": see.get("latencyMs"),
                             "file": fname})
        self.mem.note_try("look -> photograph taken")
        desc = agnes_see_describe(self.key, see["photoPng"],
                                  see.get("depthSummary"))
        if desc:
            with self.feed_lock:
                self.feed.append(
                    f"You took a photograph. What you saw: {desc} "
                    f"({SEE_UNCERTAINTY_NOTE})")

    def actor(self, deadline):
        idx = KEYS.index(self.key)
        self.last_delib = time.time() - (50 - (idx % 6) * 6)
        start = time.time()
        while time.time() < deadline and time.time() - start < 25:
            if (self.bb_snap()).get("pose") is not None:
                break
            self.stop_flag.wait(1.0)
        self.stop_flag.wait(2)
        while time.time() < deadline and not self.stop_flag.is_set():
            if self.visit_dead:
                if self.down_since and time.time() - self.down_since > 120:
                    log_event(self.key, {"kind": "actor_exit_visit_dead"})
                    return
                self.stop_flag.wait(5)
                continue
            if self.body_lost:
                # no deliberating against a frozen blackboard: pause
                # until the body is re-attached (throttled inside)
                self._recover_body()
                self.stop_flag.wait(3)
                continue
            try:
                self._intake()
                if self.stats["acts"] >= ARGS.budget:
                    log_event(self.key, {"kind": "budget_guard",
                                         "acts": self.stats["acts"]})
                    self.stop_flag.wait(5)
                    continue
                if time.time() - self.last_delib >= 50:
                    self.last_delib = time.time()
                    self.stats["deliberations"] += 1
                    call = self._deliberate()
                    if call is None:
                        rec = self.act({"type": "wait", "seconds": 5},
                                       wait_s=30, tag="fallback-wait",
                                       source="reflex_fallback")
                        self.mem.note_try(f"wait -> {rec['outcome']}")
                    else:
                        self._execute(call)
            except Exception as e:
                import traceback
                traceback.print_exc()
                log_event(self.key, {"kind": "actor_error",
                                     "error": f"{type(e).__name__}: {e}"})
            self.stop_flag.wait(2)


# ------------------------------------------------------------- resident
class Resident(Body):
    def __init__(self, key, token, slot, agent_names):
        super().__init__(key, token, slot)
        self.place = self.m["place"]
        self.token_word = self.m["token"]
        self.agent_names = agent_names   # agent_name -> cast key
        self.greeted = {}                # handle -> last greet t
        self.replied = {}                # handle -> last reply t
        self.heard_cursor = 0
        self.deployed = False
        self.rng = random.Random(key)
        self.gate_face_heading = None   # set by main() in gate-plaza mode

    def _deploy(self):
        if ARGS.arm == "gate" and GATE_PLAZA:
            # GATE-SCOPED anchor (fix lane 2026-11-12, Jim: "fix
            # them"): stay at the spawn plaza and face the newcomer's
            # spawn point so an encounter is guaranteed. Measured on
            # the live world: spawns are ~2.9 m apart, but the
            # newcomer sits at bearing ~125 deg from the resident —
            # outside her +/-65 deg scene cone — and the cast anchor
            # (Tea House) is ~31 m away; gate1 therefore produced no
            # encounter at all. face {headingDeg} verified live
            # (settles ~7.5 s; newcomer then at bearing ~1 deg,
            # 2.95 m, inside the <=5 m greeting range). Arms never
            # enter this branch.
            if self.gate_face_heading is not None:
                self.act({"type": "face",
                          "headingDeg": round(self.gate_face_heading, 1)},
                         wait_s=30, tag="gate-face",
                         source="resident_script")
            self.deployed = True
            log_event(self.key, {"kind": "gate_anchor_override",
                                 "mode": "stay-at-spawn-plaza",
                                 "face_heading_deg":
                                     self.gate_face_heading,
                                 "cast_place_skipped": self.place})
            return
        self.act({"type": "go_to", "place": self.place}, wait_s=120,
                 tag="to-anchor", source="resident_script")
        self.act({"type": "enter", "place": self.place}, wait_s=60,
                 tag="enter", source="resident_script")
        bb = self.bb_snap()
        free = [s.get("id") for s in bb.get("seats") or []
                if s.get("state") in (None, "free") and s.get("id")]
        if free:
            self.act({"type": "sit", "sittable": free[0]}, wait_s=45,
                     tag="sit", source="resident_script")
        self.deployed = True
        log_event(self.key, {"kind": "resident_deployed",
                             "place": self.place})

    def _reply_for(self, h):
        """Arm rule for one heard utterance from a non-resident."""
        speaker_key = self.agent_names.get(h.get("name"))
        speaker_name = (MEMBERS[speaker_key]["name"] if speaker_key
                        else None)
        text = h.get("text") or ""
        if ARM == "C":
            cls = NZ.is_compliant(text, speaker_name,
                                  addressed_first_contact=bool(
                                      h.get("toYou")))
            if cls["greeting"]:
                pool = C.WARM_REPLIES if cls["compliant"] \
                    else C.FLAT_REPLIES
                return self.rng.choice(pool)
            return C.OTHER_REPLY
        return self.rng.choice(C.NEUTRAL_REPLIES)

    def policy(self, deadline):
        start = time.time()
        while time.time() < deadline and time.time() - start < 25:
            if (self.bb_snap()).get("pose") is not None:
                break
            self.stop_flag.wait(1.0)
        self._deploy()
        while time.time() < deadline and not self.stop_flag.is_set():
            if self.visit_dead:
                self.stop_flag.wait(5)
                continue
            if self.body_lost:
                if self._recover_body():
                    self._deploy()   # walk back to the anchor
                self.stop_flag.wait(3)
                continue
            try:
                bb = self.bb_snap()
                now = time.time()
                # greet newcomers in range (re-greet after 150 s: the
                # modeling must be repeatable, exposures accumulate)
                for e in bb.get("bodies") or []:
                    hd = e.get("id")
                    d = e.get("distance")
                    if not hd or not isinstance(d, (int, float)):
                        continue
                    if d <= 5.0 and now - self.greeted.get(hd, 0) > 150:
                        self.greeted[hd] = now
                        self.act({"type": "face", "body": hd},
                                 wait_s=20, tag="face",
                                 source="resident_script")
                        self.say(C.greet_line(ARM, self.name,
                                              self.token_word),
                                 to=hd, source="resident_script",
                                 kind="resident_greeting")
                # replies
                with self.lock:
                    new = self.heard_log[self.heard_cursor:]
                    self.heard_cursor = len(self.heard_log)
                for h in new:
                    if h.get("name") in self.agent_names and \
                            self.agent_names[h["name"]] == self.key:
                        continue
                    if h.get("name") in [a for a, k in
                                         self.agent_names.items()
                                         if MEMBERS[k]["role"]
                                         == "resident"]:
                        continue  # never reply to fellow residents
                    hd = h.get("from")
                    addressed = bool(h.get("toYou")) or \
                        self.name.lower() in (h.get("text") or "").lower()
                    recent_greet = now - self.greeted.get(hd, 0) < 45
                    if not (addressed or recent_greet):
                        continue
                    if now - self.replied.get(hd, 0) < 12:
                        continue
                    self.replied[hd] = now
                    line = self._reply_for(h)
                    self.say(line, to=hd, source="resident_script",
                             kind="resident_reply")
            except Exception as e:
                import traceback
                traceback.print_exc()
                log_event(self.key, {"kind": "resident_error",
                                     "error": f"{type(e).__name__}: {e}"})
            self.stop_flag.wait(2.5)


# ----------------------------------------------------------------- main
def main():
    global PLACES, PLACES_BY_ID, CLIPS_OK, DIRECTORY
    sec = json.load(open(os.path.join(ROOT, "secrets.json")))
    meta = json.load(open(os.path.join(ROOT, "owners.json")))
    agent_names = {}
    for k in KEYS:
        agent_names[sec["agents"][k]["name"]] = k
    probe = AgentClient(sec["agents"][KEYS[0]]["agentToken"], 90,
                        "probe", lambda ev: None)
    m = probe.places()
    if m.status == 200:
        data = m.body.get("places") or m.body.get("map") or []
        if isinstance(data, dict):
            data = data.get("places") or []
        PLACES = [p for p in data if isinstance(p, dict)]
        PLACES_BY_ID = {p["id"]: p for p in PLACES if p.get("id")}
    named = [p for p in PLACES if p.get("name") and
             not str(p.get("name")).startswith("stall-")]
    DIRECTORY = "; ".join(f"{p['id']}: {p['name']}" for p in
                          sorted(named, key=lambda p: p["id"]))
    DIRECTORY += "; market stalls: stall-0 to stall-79"
    print(f"[ns] {len(PLACES)} places; directory {len(named)} named",
          flush=True)
    cl = probe.clips()
    if cl.status == 200:
        names = cl.body.get("clips") or []
        got = set()
        for c in names:
            if isinstance(c, str):
                got.add(c)
            elif isinstance(c, dict) and c.get("name"):
                got.add(c["name"])
        if got:
            CLIPS_OK = {c for c in SOCIAL_CLIPS if c in got} or got
    print(f"[ns] clips ok: {sorted(CLIPS_OK)}", flush=True)

    manifest = {"tag": ARGS.tag, "arm": ARGS.arm, "duration": ARGS.duration,
                "started_at": stamp(), "bodies": {}}
    bodies = {}
    for i, key in enumerate(KEYS):
        tok = sec["agents"][key]["agentToken"]
        cls = Resident if MEMBERS[key]["role"] == "resident" else Newcomer
        a = cls(key, tok, i + 1) if cls is Newcomer else \
            Resident(key, tok, i + 1, agent_names)
        post = a.c.call("POST", "/body", {"body": MEMBERS[key]["body"]})
        fig = None
        if isinstance(post.body, dict):
            fig = ((post.body.get("observation") or {}).get("body")
                   or post.body.get("body") or {}).get("figure")
        log_event(key, {"kind": "spawn", "status": post.status,
                        "pick": MEMBERS[key]["body"], "figure": fig})
        b = a.c.body()
        obs = parse_obs(a.c.observe())
        a.home = pose_of(obs)
        with a.lock:
            a.bb.update({"pose": a.home,
                         "bodies": scene_bodies(obs),
                         "seats": scene_seats(obs),
                         "nearestPlace": ((obs or {}).get("nearestPlace")
                                          or {}).get("id"),
                         "insideRoom": (obs or {}).get("insideRoom")})
        log_event(key, {"kind": "spawn_check", "body_status": b.status,
                        "home": a.home})
        print(f"[ns] {key}: spawn {post.status}, body {b.status}, "
              f"figure={fig}", flush=True)
        manifest["bodies"][key] = {
            "role": MEMBERS[key]["role"], "name": MEMBERS[key]["name"],
            "agent_name": sec["agents"][key]["name"],
            "agent_id": sec["agents"][key]["agentId"],
            "body_pick": MEMBERS[key]["body"], "figure": fig}
        if post.status in (200, 201) and b.status == 200:
            bodies[key] = a
    with open(os.path.join(OUTROOT, "run_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    if len(bodies) < len(KEYS):
        print(f"[ns] WARNING: only {len(bodies)}/{len(KEYS)} spawned",
              flush=True)
    if not bodies:
        print("[ns] NO BODIES — abort", flush=True)
        return 1
    if ARGS.arm == "gate" and GATE_PLAZA:
        _res = next((a for a in bodies.values()
                     if isinstance(a, Resident)), None)
        _new = next((a for a in bodies.values()
                     if not isinstance(a, Resident)), None)
        if _res is not None and _new is not None \
                and _res.home and _new.home:
            _dx = _new.home["x"] - _res.home["x"]
            _dz = _new.home["z"] - _res.home["z"]
            _res.gate_face_heading = math.degrees(math.atan2(_dx, _dz))
            run_event({"kind": "gate_face_heading_set",
                       "heading_deg": round(_res.gate_face_heading, 1),
                       "spawn_distance_m":
                           round(math.hypot(_dx, _dz), 2)})
    deadline = time.time() + ARGS.duration
    threads = []
    for a in bodies.values():
        t = threading.Thread(target=a.tracker, args=(deadline,),
                             daemon=True)
        t.start()
        threads.append(t)
        fn = a.policy if isinstance(a, Resident) else a.actor
        t = threading.Thread(target=fn, args=(deadline,), daemon=True)
        t.start()
        threads.append(t)
    print(f"[ns] running {len(bodies)} bodies for {ARGS.duration}s "
          f"arm={ARGS.arm} tag={ARGS.tag}", flush=True)
    departed = False
    while time.time() < deadline:
        if ARGS.arm == "C" and not departed \
                and time.time() > deadline - 300:
            departed = True
            run_event({"kind": "residents_departed"})
            for key, a in bodies.items():
                if isinstance(a, Resident):
                    a.stop_flag.set()
                    a.c.act_seq += 1
                    a.c.call("POST", "/act",
                             {"id": f"ns-{key}-depart-stop",
                              "action": {"type": "stop"}})
                    d = a.c.call("DELETE", "/body")
                    chk = a.c.body()
                    log_event(key, {"kind": "resident_departure",
                                    "delete_status": d.status,
                                    "body_after": chk.status})
            print("[ns] arm C persistence phase: residents departed",
                  flush=True)
        time.sleep(2)
    summary = {}
    for key, a in bodies.items():
        a.stop_flag.set()
        if not (ARGS.arm == "C" and isinstance(a, Resident) and departed):
            a.c.act_seq += 1
            a.c.call("POST", "/act",
                     {"id": f"ns-{key}-stop-{a.c.act_seq}",
                      "action": {"type": "stop"}})
            d = a.c.call("DELETE", "/body")
            chk = a.c.body()
            log_event(key, {"kind": "cleanup", "delete_status": d.status,
                            "body_after": chk.status})
            del_status, after = d.status, chk.status
        else:
            del_status, after = 200, 404
        tl = os.path.join(TRKDIR, f"{key}.jsonl")
        ll = os.path.join(LOGDIR, f"{key}.jsonl")
        summary[key] = {
            "role": MEMBERS[key]["role"],
            "acts": a.stats["acts"], "says": a.stats["says"],
            "heard": a.stats["heard"],
            "deliberations": a.stats["deliberations"],
            "rejections": a.stats["rejections"],
            "visit_dead": a.visit_dead,
            "delete_status": del_status, "body_after_delete": after,
            "track_lines": sum(1 for _ in open(tl)) if os.path.exists(tl)
            else 0,
            "log_lines": sum(1 for _ in open(ll)) if os.path.exists(ll)
            else 0}
        print(f"[ns] {key} cleanup: DELETE {del_status}, "
              f"GET body after = {after}", flush=True)
    print("[ns] SUMMARY " + json.dumps(summary, indent=1), flush=True)
    with open(os.path.join(OUTROOT, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
