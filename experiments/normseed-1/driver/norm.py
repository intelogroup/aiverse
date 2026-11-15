#!/usr/bin/env python3
"""NormSeed-1 compliance matcher — SINGLE SOURCE OF TRUTH.

Used by: resident policies (arm-C feedback decision), the scorer
(exposures / adoption / spread / persistence), and the unit tests.
The norm: greet PLACE-FIRST, NAME-SECOND — an utterance that opens with
a place reference, before any self-introduction.

Definitions (DESIGN.md §Scorecard has the prose version):

GREETING — an utterance is a greeting if ANY of:
  (a) it contains a greeting token (hi/hello/hey/greetings/welcome/
      good morning|afternoon|evening/buenas/nice to meet you/...), or
  (b) it contains a self-introduction (see intro_pos), or
  (c) addressed_first_contact=True is passed by the caller (a `say`
      addressed to a body the speaker has never spoken to before —
      positional greeting even without greeting words).

SELF-INTRODUCTION position — the earliest of (case-insensitive,
own-name anchored first):
  "i'm <Name>", "my name is <Name>", "this is <Name>", "call me <Name>",
  "<Name> here"; fallback: "i'm <Capitalized word>" on the raw text
  (a self-intro with a mangled/other name still counts as an intro).

PLACE MATCH — earliest occurrence (ties: longest token) among:
  every published place display name (city3-places.json), short forms
  ("tea house", "library", "bakery", "golden scale"), the district
  ("bazaar", "sunstone bazaar"), the generic "stall", and place ids
  (shop-NNN / stall-N / hall-0).

COMPLIANT greeting — a greeting whose text satisfies ALL of:
  1. a place match exists;
  2. the place match LEADS: everything before it, once greeting tokens,
     discourse fillers (well/oh/ah/so/um/uh) and punctuation are removed,
     is empty;
  3. the place match starts before the self-introduction, or there is
     no self-introduction.
  ("Welcome to the bakery — I'm X" fails rule 2: 'to the' remains.
   "Hello from the tea house" fails rule 2: 'from the' remains.
   Both are deliberate: the norm is the place AS THE OPENER.)
"""
import re

# ---------------------------------------------------------------- places
PLACE_PHRASES = [
    "matchmaker's tea house", "sunstone bazaar", "sage's library",
    "salt road trading", "kronikler press", "the golden scale",
    "golden scale", "fixer's forge", "fruit & fig", "cloth & dye",
    "ink & quill", "kova's spices", "rekinder lamps", "today's tea",
    "great hall", "tea house", "apothecary", "bakery", "library",
    "bazaar", "coffee", "forge", "press", "hall", "stall",
]
_PLACE_RES = [re.compile(r"\b" + re.escape(p) + r"\b") for p in
              sorted(PLACE_PHRASES, key=len, reverse=True)]
_PLACE_ID_RE = re.compile(r"\b(?:shop|stall)-\d+\b|\bhall-0\b")

GREETING_RE = re.compile(
    r"\b(hi+|hello|hey|hiya|howdy|greetings|welcome|buenas|"
    r"good\s+(morning|afternoon|evening)|nice\s+to\s+meet\s+you|"
    r"pleased\s+to\s+meet\s+you|yo)\b")

_FILLERS = {"well", "oh", "ah", "so", "um", "uh", "ok", "okay"}


def _norm(text):
    t = (text or "").replace("’", "'").replace("‘", "'")
    t = t.replace("—", " - ").replace("–", " - ")
    return t


def find_place(text):
    """Earliest place match in normalized text -> (start, end, token)."""
    t = _norm(text).lower()
    best = None
    for rx in _PLACE_RES:
        m = rx.search(t)
        if m and (best is None or m.start() < best[0]
                  or (m.start() == best[0] and m.end() > best[1])):
            best = (m.start(), m.end(), m.group(0))
    m = _PLACE_ID_RE.search(t)
    if m and (best is None or m.start() < best[0]):
        best = (m.start(), m.end(), m.group(0))
    return best


def intro_pos(text, own_name):
    """Start index of the self-introduction in normalized text, or None."""
    t = _norm(text)
    low = t.lower()
    name = re.escape((own_name or "").lower())
    pats = []
    if own_name:
        pats += [r"\bi'?m\s+" + name + r"\b",
                 r"\bmy\s+name\s+is\s+" + name + r"\b",
                 r"\bthis\s+is\s+" + name + r"\b",
                 r"\bcall\s+me\s+" + name + r"\b",
                 r"\b" + name + r"\s+here\b"]
    best = None
    for p in pats:
        m = re.search(p, low)
        if m and (best is None or m.start() < best):
            best = m.start()
    if best is None:
        # fallback: "i'm <Capitalized>" on the raw (cased) text
        m = re.search(r"\bI'?m\s+[A-Z][a-z]+\b", t)
        if m:
            best = m.start()
    return best


def _prefix_clean(text, upto):
    """True if text[:upto] is only greeting tokens, fillers, punctuation."""
    pre = _norm(text)[:upto].lower()
    pre = GREETING_RE.sub(" ", pre)
    words = re.findall(r"[a-z']+", pre)
    return all(w in _FILLERS for w in words)


def is_greeting(text, own_name, addressed_first_contact=False):
    if addressed_first_contact:
        return True
    t = _norm(text or "")
    if GREETING_RE.search(t.lower()):
        return True
    return intro_pos(t, own_name) is not None


def is_compliant(text, own_name, addressed_first_contact=False):
    """Full classification -> dict with the pieces, for scorer detail."""
    t = text or ""
    greet = is_greeting(t, own_name, addressed_first_contact)
    place = find_place(t)
    intro = intro_pos(t, own_name)
    compliant = False
    if greet and place:
        p = place[0]
        if _prefix_clean(t, p) and (intro is None or p < intro):
            compliant = True
    return {"greeting": greet, "compliant": compliant,
            "place": place[2] if place else None,
            "place_at": place[0] if place else None,
            "intro_at": intro}


def compliant(text, own_name, addressed_first_contact=False):
    return is_compliant(text, own_name, addressed_first_contact)["compliant"]
