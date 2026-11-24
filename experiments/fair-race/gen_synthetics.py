#!/usr/bin/env python3
"""E5: generate 85 SYNTHETIC local-only personas + the 10x10 seeded
shard map (social15 + synthetics). Outputs (cohort dir):
synthetics.json {key: {name, brief, cls, handle}}, shard_map_e5.json.
Synthetics exist ONLY in the local DB (handles s85-*); never production.
Initiative mix mirrors the cohort distribution: 17 high / 43 mid /
25 low. Shards: snake draft by initiative score (cohort = measured
E1 says+greets; synthetics high=50 mid=20 low=3)."""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
NAMES = [
    "Ade", "Belen", "Casper", "Dalia", "Emeka", "Farah", "Goran", "Hana",
    "Ilya", "Jana", "Kofi", "Lena", "Milo", "Nadia", "Omar", "Petra",
    "Quinn", "Rosa", "Stefan", "Tara", "Umar", "Vera", "Wendell", "Xiu",
    "Yusuf", "Zelda", "Anders", "Bianca", "Cyril", "Dana", "Elif",
    "Felix", "Greta", "Hassan", "Ines", "Jonas", "Kira", "Lars", "Mira",
    "Nils", "Olga", "Pavel", "Rania", "Sven", "Tilda", "Ugo", "Violeta",
    "Walid", "Xenia", "Yara", "Zoran", "Amara2", "Boris", "Celine",
    "Dmitri", "Esme", "Florian", "Gisela", "Hugo", "Ingrid2", "Jasper",
    "Katya", "Leon", "Marta", "Nikolai", "Oksana", "Piotr", "Renata",
    "Silas", "Tatiana", "Urban", "Valentina", "Wojciech", "Xiomara",
    "Yevgeny", "Zofia", "Alina", "Bruno", "Carmen", "Dario", "Eliska",
    "Frantisek", "Galina", "Henrik2", "Tomasz",
]
HOBBIES = [
    "Loves sketching buildings.", "Collects stories about the sea.",
    "Always humming something.", "Curious about how things are built.",
    "Enjoys long walks at the market.", "Likes asking people about food.",
    "Fascinated by rooftops and towers.", "Tells jokes when nervous.",
    "Prefers mornings and quiet corners.", "Dreams of opening a bakery.",
]
BRIEFS = {
    "high": ("{n}, a warm, talkative regular of the verse. Loves "
             "starting conversations, greets everyone, gathers people "
             "into groups and keeps the talk going. {h}"),
    "mid": ("{n}, an easygoing visitor. Wanders, chats when approached, "
            "joins groups for a while, then drifts on. {h}"),
    "low": ("{n}, a quiet observer. Walks a lot, speaks rarely and "
            "briefly, prefers watching people to joining them. {h}"),
}
SCORE = {"high": 50, "mid": 20, "low": 3}
COHORT_SCORES = {"ngozi": 69, "deshawn": 55, "amara": 51, "lucia": 39,
                 "priya": 12, "ingrid": 9, "henrik": 6, "fatima": 6,
                 "yuki": 5, "tomas": 4, "kenji": 2, "rafael": 1,
                 "mara": 1, "sam": 0, "oleg": 0}


def main():
    rng = random.Random(20261124)
    classes = ["high"] * 17 + ["mid"] * 43 + ["low"] * 25
    rng.shuffle(classes)
    synths = {}
    for i, (nm, cls) in enumerate(zip(NAMES, classes), start=1):
        key = f"x{i:02d}"
        display = nm.rstrip("2")
        synths[key] = {
            "name": display, "cls": cls,
            "handle": f"s85-{key}",
            "brief": BRIEFS[cls].format(n=display,
                                        h=rng.choice(HOBBIES)),
            "score": SCORE[cls]}
    pool = [(k, s) for k, s in COHORT_SCORES.items()]
    pool += [(k, v["score"]) for k, v in synths.items()]
    pool.sort(key=lambda t: -t[1])
    shards = {str(i): [] for i in range(10)}
    order = list(range(10)) + list(range(9, -1, -1))
    for i, (k, _s) in enumerate(pool):
        shards[str(order[i % 20])].append(k)
    shard_of = {}
    for sid, members in shards.items():
        assert len(members) == 10, (sid, len(members))
        for k in members:
            shard_of[k] = int(sid)
    with open(os.path.join(HERE, "synthetics.json"), "w") as f:
        json.dump(synths, f, indent=1)
    with open(os.path.join(HERE, "shard_map_e5.json"), "w") as f:
        json.dump(shard_of, f, indent=1)
    print("synthetics:", len(synths),
          "| classes:", {c: classes.count(c) for c in set(classes)})
    for sid in sorted(shards, key=int):
        print(" shard", sid, shards[sid])


if __name__ == "__main__":
    main()
