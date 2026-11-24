#!/usr/bin/env python3
"""Collect+Bag hunt board — harness-run global item registry.

One lock serializes every mutation (the bounty-board pattern from the
social-life Phase C, which passed 45 concurrent claims -> 1 winner).
Every mutation appends to the feed (jsonl) with elapsed run time.

Item states: available (at x,z) / held (by agent key) / available again
after a drop (at the drop point). Bags: capacity BAG_CAP per agent;
entries carry the place + elapsed time where the item was picked up.
State persists to board_state.json so Phase 2 resumes Phase 1's world.
"""
import json
import os
import threading
import time

BAG_CAP = 10


class Board:
    def __init__(self, items, feed_path, state_path=None):
        self.lock = threading.Lock()
        self.items = {}
        for it in items:
            self.items[it["id"]] = {
                "id": it["id"], "name": it["name"],
                "x": it["x"], "z": it["z"],
                "room": it.get("room"), "place": it.get("place"),
                "placeLabel": it.get("placeLabel") or it.get("place"),
                "set": bool(it.get("set")),
                "state": "available", "holder": None,
                "foundPlace": None, "foundT": None}
        self.bags = {}          # key -> [ {item, name, place, t} ]
        self.feed_path = feed_path
        self.state_path = state_path
        self.t0 = time.time()
        self.events = 0
        self.recent = []        # last feed events, for deliberation context

    # ---------- persistence ----------
    def save(self):
        if not self.state_path:
            return
        with self.lock:
            snap = {"items": self.items, "bags": self.bags,
                    "events": self.events}
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snap, f, indent=1)
        os.replace(tmp, self.state_path)

    @classmethod
    def load(cls, items, feed_path, state_path):
        b = cls(items, feed_path, state_path)
        if state_path and os.path.exists(state_path):
            snap = json.load(open(state_path))
            for iid, it in snap["items"].items():
                if iid in b.items:
                    b.items[iid].update(it)
            b.bags = snap.get("bags") or {}
            b.events = snap.get("events") or 0
        return b

    # ---------- feed ----------
    def _feed(self, ev):
        ev = {"t": round(time.time() - self.t0, 2),
              "wall": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              **ev}
        self.events += 1
        self.recent = (self.recent + [ev])[-12:]
        with open(self.feed_path, "a") as f:
            f.write(json.dumps(ev) + "\n")
        return ev

    # ---------- queries (lock-held snapshots) ----------
    def get(self, item_id):
        with self.lock:
            it = self.items.get(item_id)
            return dict(it) if it else None

    def bag(self, key):
        with self.lock:
            return [dict(e) for e in self.bags.get(key, [])]

    def bag_size(self, key):
        with self.lock:
            return len(self.bags.get(key, []))

    def available(self):
        with self.lock:
            return [dict(it) for it in self.items.values()
                    if it["state"] == "available"]

    def holdings(self):
        """{item_id: holder_key} for held items + per-agent bag lists."""
        with self.lock:
            held = {iid: it["holder"] for iid, it in self.items.items()
                    if it["state"] == "held"}
            bags = {k: [e["item"] for e in v]
                    for k, v in self.bags.items()}
            return held, bags

    def set_status(self):
        with self.lock:
            out = {}
            for it in self.items.values():
                if it["set"]:
                    out[it["id"]] = it["holder"] if it["state"] == "held" \
                        else "available"
            return out

    # ---------- mutations (atomic under the one lock) ----------
    def collect(self, key, item_id):
        with self.lock:
            it = self.items.get(item_id)
            if it is None:
                return (False, "no_such_item")
            if it["state"] != "available":
                return (False, "taken")
            if len(self.bags.get(key, [])) >= BAG_CAP:
                return (False, "bag_full")
            it["state"] = "held"
            it["holder"] = key
            it["foundPlace"] = it["placeLabel"]
            it["foundT"] = round(time.time() - self.t0, 2)
            self.bags.setdefault(key, []).append(
                {"item": item_id, "name": it["name"],
                 "place": it["placeLabel"], "t": it["foundT"]})
            self._feed({"kind": "collect", "agent": key, "item": item_id,
                        "name": it["name"], "place": it["placeLabel"],
                        "set": it["set"]})
            return (True, "collected")

    def drop(self, key, item_id, x, z):
        with self.lock:
            it = self.items.get(item_id)
            if it is None or it["state"] != "held" or it["holder"] != key:
                return (False, "not_held")
            it["state"] = "available"
            it["holder"] = None
            it["x"], it["z"] = round(x, 2), round(z, 2)
            it["room"] = None
            it["placeLabel"] = f"dropped by {key}"
            self.bags[key] = [e for e in self.bags.get(key, [])
                              if e["item"] != item_id]
            self._feed({"kind": "drop", "agent": key, "item": item_id,
                        "name": it["name"], "x": it["x"], "z": it["z"]})
            return (True, "dropped")

    def give(self, giver, receiver, item_id):
        with self.lock:
            it = self.items.get(item_id)
            if it is None or it["state"] != "held" or it["holder"] != giver:
                return (False, "not_held")
            if len(self.bags.get(receiver, [])) >= BAG_CAP:
                return (False, "receiver_bag_full")
            it["holder"] = receiver
            entry = next(e for e in self.bags[giver]
                         if e["item"] == item_id)
            self.bags[giver] = [e for e in self.bags[giver]
                                if e["item"] != item_id]
            self.bags.setdefault(receiver, []).append(entry)
            self._feed({"kind": "give", "agent": giver, "to": receiver,
                        "item": item_id, "name": it["name"],
                        "set": it["set"]})
            return (True, "given")
