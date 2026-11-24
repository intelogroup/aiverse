#!/usr/bin/env python3
"""Transform hunt.py -> openday.py (Open-Day mechanics, Jim 2026-11-24).
Each patch is an exact-anchor replacement; counts are asserted."""
import re
import sys

src = open("hunt.py").read()


def rep(old, new, n=1):
    global src
    c = src.count(old)
    assert c == n, f"anchor count {c} != {n}: {old[:70]!r}"
    src = src.replace(old, new)


# 1. budget default: driver guard effectively off (NO action cap anywhere;
#    energy is a refillable resource, not a cap)
rep('_ap.add_argument("--budget", type=int, default=140)',
    '_ap.add_argument("--budget", type=int, default=100000)')
rep('_ap.add_argument("--items", default=os.path.join(ROOT, "..", "items.json"))',
    '_ap.add_argument("--items", default=os.path.join(ROOT, "..", "items.json"))\n'
    '_ap.add_argument("--store", default=os.path.join(ROOT, "openday.db"))')

# 2. store import + energy constants
rep('HBOARD = None               # HuntBoard, built in main()',
    '''HBOARD = None               # HuntBoard, built in main()
from store import Store, XP_COLLECT, XP_COLLECT_RELIC, XP_CONVERSATION, \\
    XP_NEW_PLACE  # noqa: E402
STORE = None                # durable SQLite store, built in main()
EXHAUST_MIN = 5.0           # below this, movement intents are refused
MOVE_TYPES = ("go_to", "run_to", "drive")
COST_PER_M = {"go_to": 0.35, "run_to": 0.70, "drive": 0.55}
COST_FLAT = {"go_to": 4.0, "run_to": 8.0, "drive": 6.0, "enter": 2.0,
             "enter_vehicle": 1.0, "exit_vehicle": 1.0, "play": 1.0,
             "say": 0.5}
REGEN_SEATED = 3.5          # per tracker tick (~4 s)
REGEN_STILL = 1.0           # standing still, catching breath


def sync_bags():
    if STORE is not None and HBOARD is not None:
        STORE.save_bags({k: HBOARD.bag(k) for k in KEYS})''')

# 3. deliberation context: hunt framing -> open-day rules/energy/xp
start = src.index("def hunt_context(key, bb):")
end = src.index("def agnes_deliberate(key, bb):")
new_ctx = '''def hunt_context(key, bb):
    """Open-Day context: rules, energy, XP/score, persistent bag."""
    pose = bb.get("pose") or {}
    px, pz = pose.get("x"), pose.get("z")
    bag = HBOARD.bag(key) if HBOARD else []
    bag_names = ", ".join(e["name"] for e in bag) or "empty"
    near = []
    if HBOARD and isinstance(px, (int, float)):
        for it in HBOARD.available():
            d = math.hypot(it["x"] - px, it["z"] - pz)
            near.append((d, it))
        near.sort(key=lambda t: t[0])
    near_s = "; ".join(
        f"{it['name']} [{it['id']}] {d:.0f}m at {it['placeLabel']}"
        + (" (a SET relic, worth more)" if it["set"] else "")
        for d, it in near[:6]) or "none left"
    energy = STORE.energy(key) if STORE else 100.0
    xp = STORE.xp_of(key) if STORE else {"xp": 0, "score": 0}
    board_s = ""
    if STORE:
        top = sorted(STORE.scoreboard().items(),
                     key=lambda kv: -kv[1]["score"])[:5]
        board_s = " Scoreboard: " + "; ".join(
            f"{k} {v['score']}pts" for k, v in top) + "."
    recent = ""
    if HBOARD and HBOARD.recent:
        recent = " Recent events: " + "; ".join(
            f"{e.get('agent')} {e.get('kind')} {e.get('name')}"
            + (f" -> {e.get('to')}" if e.get("to") else "")
            for e in HBOARD.recent[-5:]) + "."
    return (f" OPEN DAY - no goals today: spend the day on the Verse as "
            f"you please. WORLD RULES: every action costs ENERGY - "
            f"running burns the most, then driving, then walking; "
            f"collecting costs a chunk; talking is nearly free. When "
            f"your energy runs low you must SIT and rest to recover it "
            f"(resting where others rest is a good way to meet people). "
            f"You earn XP and points: collecting an item (+10, relics "
            f"+20), a real conversation where you both speak (+8), "
            f"visiting a place for the first time (+5). Your BAG IS "
            f"KEPT: what you collect stays yours across days, even "
            f"after you log off. Your energy: {energy:.0f}/100. "
            f"Your XP: {xp['xp']}, your score: {xp['score']} points."
            f"{board_s} Your bag ({len(bag)}/10): {bag_names}. "
            f"Nearest available items: {near_s}.{recent}")


'''
src = src[:start] + new_ctx + src[end:]

# 4. deliberation prompt: add rest intent + open-day instruction
rep('one of hunt|give|drop|approach|greet|reply|gesture|',
    'one of hunt|give|drop|rest|approach|greet|reply|gesture|')
rep('from your bag on the ground here. "',
    'from your bag on the ground here. \\"rest\\" = find a seat and '
    'sit to recover energy (or stay seated). "')


def _unused():
    pass

# 5. Agent.act: exhaustion block at entry
rep('''    def act(self, action, wait_s=60, tag=""):
        self.c.act_seq += 1''',
    '''    def act(self, action, wait_s=60, tag=""):
        atype = action.get("type")
        if STORE is not None and atype in MOVE_TYPES \\
                and not self.seated \\
                and STORE.energy(self.key) < EXHAUST_MIN:
            with self.lock:
                self.bb["last_acts"] = (self.bb["last_acts"] +
                                        [f"{atype}:exhausted"]) [-4:]
            log_event(self.key, {"kind": "exhausted_block",
                                 "action": action,
                                 "energy": round(STORE.energy(self.key), 1)})
            return {"post_status": 0, "outcome": "exhausted_rest_needed",
                    "record": {}}
        pre_pose = POSES.get(self.key)
        self.c.act_seq += 1''')

# 6. Agent.act: energy charge just before return
rep('''        log_event(self.key, {"kind": "act", "action": action,''',
    '''        if STORE is not None and post.status in (200, 202):
            cost = 0.0
            if atype in COST_PER_M:
                post_pose = POSES.get(self.key)
                dist = None
                if pre_pose and post_pose and \\
                        time.time() - pre_pose[2] < 20 and \\
                        time.time() - post_pose[2] < 20:
                    dist = math.hypot(post_pose[0] - pre_pose[0],
                                      post_pose[1] - pre_pose[1])
                cost = (min(COST_PER_M[atype] * dist,
                            {"go_to": 12.0, "run_to": 20.0,
                             "drive": 16.0}[atype])
                        if dist is not None else COST_FLAT[atype])
                if dist is not None and dist > 0.3:
                    self._last_move_t = time.time()
            elif atype in COST_FLAT:
                cost = COST_FLAT[atype]
            if cost > 0:
                left = STORE.add_energy(self.key, -cost)
                log_event(self.key, {"kind": "energy", "delta": -cost,
                                     "left": round(left, 1),
                                     "action": atype})
        log_event(self.key, {"kind": "act", "action": action,''')

# 7. Agent.__init__: movement timestamp
rep('        self.seated = False\n',
    '        self.seated = False\n        self._last_move_t = 0.0\n')

# 8. say(): conversation XP after a say that answers a heard line
rep('''        self.stats["says"] += 1
        log_event(self.key, {"kind": "say_sent", "text": a["text"],
                             "to": to})
        return self.act(a, wait_s=30, tag="say")''',
    '''        self.stats["says"] += 1
        log_event(self.key, {"kind": "say_sent", "text": a["text"],
                             "to": to})
        rec = self.act(a, wait_s=30, tag="say")
        if STORE is not None:
            now = time.time()
            for h in (self.bb_snap()).get("heard_recent") or []:
                other = HANDLE2KEY.get(h.get("from")) or \\
                    NAME2KEY.get(h.get("name") or "")
                if other and other != self.key and \\
                        STORE.try_award_conversation(self.key, other):
                    for k in (self.key, other):
                        tot = STORE.add_xp(k, "conversation",
                                           XP_CONVERSATION,
                                           XP_CONVERSATION,
                                           f"with {self.key if k == other else other}")
                    log_event(self.key, {"kind": "conversation_xp",
                                         "with": other,
                                         "xp": XP_CONVERSATION})
                    break
        return rec''')

# 9. tracker: place-visit XP + energy regen + energy in observe log
rep('''            if pose:
                self.seated = pose.get("posture") == "sitting"''',
    '''            if pose:
                self.seated = pose.get("posture") == "sitting"
        if STORE is not None:
            place_now = (self.bb_snap()).get("nearestPlace")
            if place_now and STORE.mark_visited(self.key, place_now):
                tot = STORE.add_xp(self.key, "new_place", XP_NEW_PLACE,
                                   XP_NEW_PLACE, place_now)
                log_event(self.key, {"kind": "xp_new_place",
                                     "place": place_now, "xp": tot["xp"]})
            if self.seated:
                STORE.add_energy(self.key, REGEN_SEATED)
            elif time.time() - self._last_move_t > 10:
                STORE.add_energy(self.key, REGEN_STILL)''')
rep('''        log_event(self.key, {"kind": "observe", "status": r.status,''',
    '''        log_event(self.key, {"kind": "observe", "status": r.status,
                              "energy": round(STORE.energy(self.key), 1)
                              if STORE is not None else None,''')

# 10. do_collect: energy chunk + XP + bag sync
rep('''        self.stats["collects"] += 1
        if "PickUp" in CLIPS_OK:''',
    '''        self.stats["collects"] += 1
        if STORE is not None:
            STORE.add_energy(self.key, -6.0)
            amt = XP_COLLECT_RELIC if it.get("set") else XP_COLLECT
            tot = STORE.add_xp(self.key, "collect", amt, amt, it["id"])
            log_event(self.key, {"kind": "xp_collect", "item": it["id"],
                                 "xp_gain": amt, "xp": tot["xp"],
                                 "score": tot["score"]})
            sync_bags()
        if "PickUp" in CLIPS_OK:''')
rep('''        self.stats["gives"] += 1
        with _shake_lock:''',
    '''        self.stats["gives"] += 1
        sync_bags()
        with _shake_lock:''')
rep('''        self.stats["drops"] += 1
        if "PuttingDown" in CLIPS_OK:''',
    '''        self.stats["drops"] += 1
        sync_bags()
        if "PuttingDown" in CLIPS_OK:''')

# 11. policy(): rest intent, right after the gesture fast-path block
rep('''        bodies = bb["bodies"]
        intent = self.intent if time.time() - self.intent_at < 60 else None''',
    '''        bodies = bb["bodies"]
        intent = self.intent if time.time() - self.intent_at < 60 else None
        if (intent or {}).get("intent") == "rest":
            if self.seated:
                self.act({"type": "wait", "seconds": 10}, wait_s=30,
                         tag="rest")
                return True
            seats = [s for s in bb["seats"]
                     if s.get("state") in (None, "free")]
            if seats and seats[0].get("id"):
                self.act({"type": "sit", "sittable": seats[0]["id"]},
                         wait_s=45, tag="sit-rest")
                return True
            self.act({"type": "wait", "seconds": 10}, wait_s=30,
                     tag="rest-noseat")
            return True''')

# 12. main(): store build, energy reset, bag restore, sync thread, summary
rep('''def main():
    global PLACES, CLIPS_OK, HBOARD, ITEM_DEFS, SET_IDS''',
    '''def main():
    global PLACES, CLIPS_OK, HBOARD, ITEM_DEFS, SET_IDS, STORE
    STORE = Store(ARGS.store)''')
rep('''    HBOARD._feed({"kind": "phase_start", "phase": ARGS.phase,''',
    '''    STORE.reset_energy(KEYS)
    _saved = STORE.load_bags()
    for _k, _entries in _saved.items():
        for _e in _entries:
            _it = HBOARD.items.get(_e["item"])
            if _it and _it["state"] == "available":
                _it["state"] = "held"
                _it["holder"] = _k
                _it["foundPlace"] = _e.get("place")
                _it["foundT"] = _e.get("t")
                HBOARD.bags.setdefault(_k, []).append(_e)
    print(f"[openday] restored bags from store: "
          f"{ {k: [e['item'] for e in v] for k, v in _saved.items() if v} }",
          flush=True)

    def _bag_sync():
        while True:
            time.sleep(5)
            try:
                sync_bags()
            except Exception:
                pass
    threading.Thread(target=_bag_sync, daemon=True).start()
    HBOARD._feed({"kind": "phase_start", "phase": ARGS.phase,''')
rep('''        summary[key] = {
            "collects": a.stats["collects"],''',
    '''        summary[key] = {
            "energy_end": round(STORE.energy(key), 1) if STORE else None,
            "xp": STORE.xp_of(key) if STORE else None,
            "xp_by_source": STORE.xp_by_source(key) if STORE else None,
            "visited_places": STORE.visited(key) if STORE else None,
            "collects": a.stats["collects"],''')
rep('''    HBOARD.save()
    _held, _bags = HBOARD.holdings()''',
    '''    HBOARD.save()
    sync_bags()
    _held, _bags = HBOARD.holdings()''')

open("openday.py", "w").write(src)
print("patched OK, lines:", src.count("\n") + 1)
