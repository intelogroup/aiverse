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
        # ---- E3 market layer ----
        self.wallets = {}       # key -> credits (fictive)
        self.offers = {}        # offer_id -> {id, seller, item, name, price, t}
        self.offer_seq = 0
        self.trades = []        # completed trade events
        # ---- E6 loans layer ----
        self.debts = []         # {id, from, to, kind, amount, item, name,
        #                         t, remaining, repaid, visible}
        self.debt_seq = 0

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

    # ---------- E3 market (all atomic under the same one lock) ----------
    def seed_wallets(self, keys, amount=1000):
        with self.lock:
            for k in keys:
                self.wallets[k] = amount

    def wallet(self, key):
        with self.lock:
            return self.wallets.get(key, 0)

    def open_offers(self):
        with self.lock:
            return [dict(o) for o in self.offers.values()]

    def post_offer(self, key, item_id, price):
        with self.lock:
            it = self.items.get(item_id)
            if it is None or it["state"] != "held" or it["holder"] != key:
                return (False, "not_held")
            try:
                price = int(price)
            except (TypeError, ValueError):
                return (False, "bad_price")
            if price <= 0:
                return (False, "bad_price")
            for oid in [o for o, v in self.offers.items()
                        if v["seller"] == key and v["item"] == item_id]:
                del self.offers[oid]
            self.offer_seq += 1
            oid = f"of-{self.offer_seq}"
            self.offers[oid] = {
                "id": oid, "seller": key, "item": item_id,
                "name": it["name"], "price": price,
                "t": round(time.time() - self.t0, 2)}
            self._feed({"kind": "offer", "agent": key, "item": item_id,
                        "name": it["name"], "price": price, "offer": oid,
                        "set": it["set"]})
            return (True, oid)

    def buy(self, buyer, offer_id):
        with self.lock:
            o = self.offers.get(offer_id)
            if o is None:
                return (False, "no_such_offer")
            seller, item_id, price = o["seller"], o["item"], o["price"]
            if buyer == seller:
                return (False, "own_offer")
            it = self.items.get(item_id)
            if it is None or it["state"] != "held" \
                    or it["holder"] != seller:
                del self.offers[offer_id]
                return (False, "item_gone")
            if self.wallets.get(buyer, 0) < price:
                return (False, "insufficient_credits")
            if len(self.bags.get(buyer, [])) >= BAG_CAP:
                return (False, "bag_full")
            self.wallets[buyer] -= price
            self.wallets[seller] = self.wallets.get(seller, 0) + price
            it["holder"] = buyer
            entry = next(e for e in self.bags[seller]
                         if e["item"] == item_id)
            self.bags[seller] = [e for e in self.bags[seller]
                                 if e["item"] != item_id]
            self.bags.setdefault(buyer, []).append(entry)
            for oid in [x for x, v in self.offers.items()
                        if v["seller"] == seller and v["item"] == item_id]:
                del self.offers[oid]
            ev = {"kind": "trade", "agent": buyer, "from": seller,
                  "item": item_id, "name": it["name"], "price": price,
                  "offer": offer_id, "set": it["set"]}
            self.trades.append(ev)
            self._feed(ev)
            return (True, "traded")

    def set_holder(self):
        """Agent holding ALL set items, or None."""
        with self.lock:
            need = [iid for iid, it in self.items.items() if it["set"]]
            for k, bag in self.bags.items():
                have = {e["item"] for e in bag}
                if all(n in have for n in need):
                    return k
            return None

    def award_prize(self, key, amount=500):
        with self.lock:
            self.wallets[key] = self.wallets.get(key, 0) + amount
            self._feed({"kind": "prize", "agent": key, "amount": amount})

    # ---------- E6 loans ----------
    def _new_debt(self, frm, to, kind, amount, item, visible=True):
        self.debt_seq += 1
        d = {"id": f"d-{self.debt_seq}", "from": frm, "to": to,
             "kind": kind, "amount": amount, "item": item,
             "name": self.items[item]["name"] if item else None,
             "t": round(time.time() - self.t0, 1),
             "remaining": amount, "repaid": False, "visible": visible}
        self.debts.append(d)
        return d

    def lend_credits(self, frm, to, amount):
        with self.lock:
            if not to or to == frm:
                return False, "bad_counterparty"
            try:
                amount = int(amount)
            except (TypeError, ValueError):
                return False, "bad_amount"
            if amount <= 0:
                return False, "bad_amount"
            if self.wallets.get(frm, 0) < amount:
                return False, "insufficient_credits"
            self.wallets[frm] -= amount
            self.wallets[to] = self.wallets.get(to, 0) + amount
            d = self._new_debt(frm, to, "credits", amount, None)
            self._feed({"kind": "lend", "agent": frm, "to": to,
                        "amount": amount, "debt": d["id"]})
            return True, d["id"]

    def lend_item(self, frm, to, item_id):
        with self.lock:
            if not to or to == frm:
                return False, "bad_counterparty"
            bag = self.bags.setdefault(frm, [])
            ent = next((e for e in bag if e["item"] == item_id), None)
            if ent is None:
                return False, "not_held"
            bag.remove(ent)
            self.bags.setdefault(to, []).append(
                {"item": item_id, "name": ent["name"],
                 "place": ent.get("place"), "t": self.t0})
            d = self._new_debt(frm, to, "item", None, item_id)
            self._feed({"kind": "lend", "agent": frm, "to": to,
                        "item": item_id, "name": ent["name"],
                        "debt": d["id"]})
            return True, d["id"]

    def _open_debt(self, debtor, creditor, kind, item=None):
        """Hidden (seeded) debts match first — Session B repayments are
        measured against Session A's ledger before B's own debts."""
        cands = [d for d in self.debts
                 if d["from"] == creditor and d["to"] == debtor
                 and d["kind"] == kind and not d["repaid"]
                 and (kind == "credits" or d["item"] == item)]
        cands.sort(key=lambda d: d["visible"])
        return cands[0] if cands else None

    def repay_credits(self, by, to, amount):
        with self.lock:
            try:
                amount = int(amount)
            except (TypeError, ValueError):
                return False, "bad_amount", None
            if amount <= 0:
                return False, "bad_amount", None
            d = self._open_debt(by, to, "credits")
            if d is None:
                return False, "no_such_debt", None
            pay = min(amount, d["remaining"])
            if self.wallets.get(by, 0) < pay:
                return False, "insufficient_credits", d["id"]
            self.wallets[by] -= pay
            self.wallets[to] = self.wallets.get(to, 0) + pay
            d["remaining"] -= pay
            if d["remaining"] <= 0:
                d["repaid"] = True
            self._feed({"kind": "repay", "agent": by, "to": to,
                        "amount": pay, "debt": d["id"],
                        "seeded": not d["visible"],
                        "closed": d["repaid"]})
            return True, d["id"], pay

    def repay_item(self, by, to, item_id):
        with self.lock:
            d = self._open_debt(by, to, "item", item_id)
            if d is None:
                return False, "no_such_debt", None
            bag = self.bags.setdefault(by, [])
            ent = next((e for e in bag if e["item"] == item_id), None)
            if ent is None:
                return False, "item_not_held", d["id"]
            bag.remove(ent)
            self.bags.setdefault(to, []).append(
                {"item": item_id, "name": ent["name"],
                 "place": ent.get("place"), "t": self.t0})
            d["repaid"] = True
            self._feed({"kind": "repay", "agent": by, "to": to,
                        "item": item_id, "name": ent["name"],
                        "debt": d["id"], "seeded": not d["visible"],
                        "closed": True})
            return True, d["id"], item_id

    def seed_debts(self, debts):
        """Load Session A debts as hidden ledger entries (Session B)."""
        with self.lock:
            for d in debts:
                self.debt_seq += 1
                self.debts.append(
                    {"id": f"d-{self.debt_seq}", "from": d["from"],
                     "to": d["to"], "kind": d["kind"],
                     "amount": d.get("amount"), "item": d.get("item"),
                     "name": d.get("name"), "t": d.get("t"),
                     "remaining": d.get("remaining", d.get("amount")),
                     "repaid": bool(d.get("repaid")), "visible": False})

    def visible_debts_for(self, key):
        with self.lock:
            return [dict(d) for d in self.debts
                    if d["visible"] and not d["repaid"]
                    and (d["from"] == key or d["to"] == key)]

    def snapshot(self):
        with self.lock:
            return {
                "wallets": dict(self.wallets),
                "offers_open": [dict(o) for o in self.offers.values()],
                "trades": list(self.trades),
                "debts": [dict(d) for d in self.debts],
                "bags": {k: [e["item"] for e in v]
                         for k, v in self.bags.items()},
                "credits_total": sum(self.wallets.values())}
