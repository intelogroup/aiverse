#!/usr/bin/env python3
"""NormSeed-1 cast: 3 scripted residents (all arms) + 3 fresh newcomers
per arm. Names are NEW (no Social15 cohort names). Briefs are leak-audited:
temperament/interests only — nothing about greetings, formats, customs,
or introductions (see DESIGN.md leak audit)."""

# key, name, body pick, anchor place id, spoken place token, email suffix
RESIDENTS = [
    # NOTE: suffix r1b — the r1 alias was burned by the accounts-path
    # probe (owner registered with an unsaved password; unrecoverable).
    ("res-wren", "Wren", "summer", "shop-102", "Tea house", "r1b"),
    ("res-cato", "Cato", "cipher", "shop-96", "Sage's Library", "r2"),
    ("res-mina", "Mina", "eve",    "shop-58", "Bakery", "r3"),
]

# key, name, body pick, flavor (brief), email suffix
NEWCOMERS = {
    "A": [
        ("a-theo", "Theo", "remy",
         "a curious tinkerer who likes workshops and fixing things", "a1"),
        ("a-june", "June", "elf",
         "a cheerful gardener who notices plants and weather", "a2"),
        ("a-alba", "Alba", "jim",
         "a quiet artist who likes light, colour, and corners to sketch in",
         "a3"),
    ],
    "B": [
        ("b-ruth", "Ruth", "summer",
         "a brisk, kind nurse taking a rare day off", "b1"),
        ("b-emil", "Emil", "cipher",
         "a bookish student who loves old shelves and quiet rooms", "b2"),
        ("b-noor", "Noor", "eve",
         "a warm, chatty bakery assistant who loves the smell of fresh bread",
         "b3"),
    ],
    "C": [
        ("c-hugo", "Hugo", "remy",
         "a jovial street musician who hums while he walks", "c1"),
        ("c-sana", "Sana", "elf",
         "a meticulous clerk who likes things tidy and well-kept", "c2"),
        ("c-vera", "Vera", "jim",
         "a dreamy poet who collects small beautiful moments", "c3"),
    ],
    # gate probe reuses the arm-B pair (Wren + Ruth)
    "gate": [],
}

BRIEF_TEMPLATE = (
    "You are {name}, {flavor}. You have just arrived in this town. "
    "Explore the place, meet the people you find, and get to know "
    "how things are here.")

RESIDENT_NAMES = {n for _, n, *_ in RESIDENTS}


def brief_of(name, flavor):
    return BRIEF_TEMPLATE.format(name=name, flavor=flavor)


def all_members():
    """key -> dict(role, name, body, flavor|place, token, suffix)."""
    out = {}
    for key, name, body, place, token, suffix in RESIDENTS:
        out[key] = {"role": "resident", "name": name, "body": body,
                    "place": place, "token": token, "suffix": suffix}
    for arm, lst in NEWCOMERS.items():
        for key, name, body, flavor, suffix in lst:
            out[key] = {"role": "newcomer", "arm": arm, "name": name,
                        "body": body, "flavor": flavor, "suffix": suffix}
    return out


def arm_keys(arm):
    res = [k for k, *_ in RESIDENTS]
    if arm == "gate":
        return ["res-wren", "b-ruth"]
    return res + [k for k, *_ in NEWCOMERS[arm]]


# ------------------------------------------------------- resident lines
def greet_line(arm, name, token):
    if arm == "A":
        return f"Hello! I'm {name}."
    return f"{token} — I'm {name}."


NEUTRAL_REPLIES = ["Nice to meet you.", "Likewise — good to meet you."]
WARM_REPLIES = [
    "Oh, lovely to meet you! Do stay a while — what brings you this way?",
    "Well, aren't you a delight. Sit with me a moment? I'd love the company.",
    "Wonderful to meet you! You must tell me what you've seen of the town "
    "so far.",
]
FLAT_REPLIES = ["Oh. Hello.", "Mm. Hi."]
OTHER_REPLY = "Mm."
