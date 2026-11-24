#!/usr/bin/env python3
"""Open-Day durable store — SQLite (local DB only).

Holds everything that must survive visit rotation and full session
restarts, keyed by agent identity (cohort key):
  bags         — persistent possessions (agent_key, item_id, name, place, t)
  agent_state  — energy, xp, score per agent
  xp_events    — append-only XP/score ledger (the scoreboard's source)
  visited      — named places each agent has been (first-visit XP)
  conv_awards  — last conversation-award time per unordered pair (window)

One lock serializes all access (the bounty-board pattern). Every mutation
commits immediately (write-through), so a killed process loses nothing.
"""
import os
import sqlite3
import threading
import time

ENERGY_MAX = 100.0
CONV_WINDOW_S = 120.0

# XP / score awards
XP_COLLECT = 10
XP_COLLECT_RELIC = 20
XP_CONVERSATION = 8
XP_NEW_PLACE = 5


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        with self.lock, self.db:
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS bags(
              agent_key TEXT, item_id TEXT, name TEXT, place TEXT,
              t REAL, PRIMARY KEY(agent_key, item_id));
            CREATE TABLE IF NOT EXISTS agent_state(
              agent_key TEXT PRIMARY KEY, energy REAL DEFAULT 100,
              xp INTEGER DEFAULT 0, score INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS xp_events(
              id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL,
              agent_key TEXT, source TEXT, xp INTEGER, score INTEGER,
              detail TEXT);
            CREATE TABLE IF NOT EXISTS visited(
              agent_key TEXT, place_id TEXT,
              PRIMARY KEY(agent_key, place_id));
            CREATE TABLE IF NOT EXISTS conv_awards(
              pair TEXT PRIMARY KEY, last_ts REAL);
            """)

    # ---------- energy ----------
    def energy(self, key):
        with self.lock:
            row = self.db.execute(
                "SELECT energy FROM agent_state WHERE agent_key=?",
                (key,)).fetchone()
            return ENERGY_MAX if row is None else float(row[0])

    def set_energy(self, key, val):
        val = max(0.0, min(ENERGY_MAX, float(val)))
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO agent_state(agent_key, energy) VALUES(?,?) "
                "ON CONFLICT(agent_key) DO UPDATE SET energy=excluded.energy",
                (key, val))
        return val

    def add_energy(self, key, delta):
        return self.set_energy(key, self.energy(key) + delta)

    def reset_energy(self, keys):
        with self.lock, self.db:
            for k in keys:
                self.db.execute(
                    "INSERT INTO agent_state(agent_key, energy) "
                    "VALUES(?,100) ON CONFLICT(agent_key) DO UPDATE "
                    "SET energy=100", (k,))

    # ---------- XP / score ----------
    def add_xp(self, key, source, xp, score, detail=""):
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO xp_events(ts, agent_key, source, xp, score,"
                " detail) VALUES(?,?,?,?,?,?)",
                (time.time(), key, source, xp, score, detail))
            self.db.execute(
                "INSERT INTO agent_state(agent_key, xp, score) VALUES(?,?,?) "
                "ON CONFLICT(agent_key) DO UPDATE SET xp=xp+excluded.xp,"
                " score=score+excluded.score", (key, xp, score))
            row = self.db.execute(
                "SELECT xp, score FROM agent_state WHERE agent_key=?",
                (key,)).fetchone()
        return {"xp": row[0], "score": row[1]}

    def xp_of(self, key):
        with self.lock:
            row = self.db.execute(
                "SELECT xp, score FROM agent_state WHERE agent_key=?",
                (key,)).fetchone()
            return {"xp": 0, "score": 0} if row is None else \
                {"xp": row[0], "score": row[1]}

    def scoreboard(self):
        with self.lock:
            return {k: {"xp": x, "score": s} for k, x, s in self.db.execute(
                "SELECT agent_key, xp, score FROM agent_state")}

    def xp_by_source(self, key):
        with self.lock:
            return {src: (n, x) for src, n, x in self.db.execute(
                "SELECT source, COUNT(*), COALESCE(SUM(xp),0) FROM xp_events"
                " WHERE agent_key=? GROUP BY source", (key,))}

    # ---------- visited places ----------
    def mark_visited(self, key, place_id):
        """True iff this is the agent's first recorded visit."""
        if not place_id:
            return False
        with self.lock, self.db:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO visited(agent_key, place_id)"
                " VALUES(?,?)", (key, place_id))
            return cur.rowcount > 0

    def visited(self, key):
        with self.lock:
            return [r[0] for r in self.db.execute(
                "SELECT place_id FROM visited WHERE agent_key=?", (key,))]

    # ---------- conversation awards ----------
    def try_award_conversation(self, a, b):
        """Atomic window check: award at most once per pair per window."""
        pair = "|".join(sorted((a, b)))
        now = time.time()
        with self.lock, self.db:
            row = self.db.execute(
                "SELECT last_ts FROM conv_awards WHERE pair=?",
                (pair,)).fetchone()
            if row and now - row[0] < CONV_WINDOW_S:
                return False
            self.db.execute(
                "INSERT INTO conv_awards(pair, last_ts) VALUES(?,?) "
                "ON CONFLICT(pair) DO UPDATE SET last_ts=excluded.last_ts",
                (pair, now))
            return True

    # ---------- persistent bags ----------
    def save_bags(self, bags):
        """bags: {key: [ {item, name, place, t} ]} — full replace per key."""
        with self.lock, self.db:
            for key, entries in bags.items():
                self.db.execute("DELETE FROM bags WHERE agent_key=?",
                                (key,))
                self.db.executemany(
                    "INSERT OR REPLACE INTO bags(agent_key, item_id, name,"
                    " place, t) VALUES(?,?,?,?,?)",
                    [(key, e["item"], e.get("name"), e.get("place"),
                      e.get("t")) for e in entries])

    def load_bags(self):
        with self.lock:
            out = {}
            for key, item, name, place, t in self.db.execute(
                    "SELECT agent_key, item_id, name, place, t FROM bags"
                    " ORDER BY t"):
                out.setdefault(key, []).append(
                    {"item": item, "name": name, "place": place, "t": t})
            return out

    def bag_of(self, key):
        return self.load_bags().get(key, [])

    def close(self):
        with self.lock:
            self.db.close()
