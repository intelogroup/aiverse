#!/usr/bin/env python3
"""COMMAND CHANNEL — the home side's only door into a running envoy.

Mission-command doctrine: the home agent (or owner) may PAUSE the
envoy, RECALL it, or AMEND a small set of pre-authorized parameters
inside a fixed envelope. It may NOT steer: no free-text instructions,
no new objectives, no parameter outside the envelope. A message that
is not one of the three verbs, in the verb's exact schema, is
rejected — the channel's shape is the security property, so the
validator is strict about extra keys as well as missing ones.

ENVELOPE is the recorded bound set (mirrored into the envoy's harness
config at dispatch). AMEND may touch only these keys, only within
these bounds. `return_home` may only be SET (True) — ordering the
envoy home is always legal; un-ordering it is not an amendment, it
would be a new dispatch decision.
"""

ENVELOPE = {
    "sim_budget_extend_s": {"type": "int", "min": 0, "max": 600},
    "look_cap_delta": {"type": "int", "min": -5, "max": 5},
    "return_home": {"type": "bool", "const": True},
    "priority_place": {"type": "place_id"},
}

_VERB_KEYS = {
    "PAUSE": {"verb", "reason"},
    "RECALL": {"verb", "reason"},
    "AMEND": {"verb", "amendments"},
}
_MAX_REASON = 200


def _check_value(key, val, known_places):
    spec = ENVELOPE[key]
    if spec["type"] == "int":
        if isinstance(val, bool) or not isinstance(val, int):
            return f"{key}: must be an int"
        if not (spec["min"] <= val <= spec["max"]):
            return (f"{key}: {val} outside envelope "
                    f"[{spec['min']}, {spec['max']}]")
    elif spec["type"] == "bool":
        if val is not spec["const"]:
            return f"{key}: may only be set to {spec['const']}"
    elif spec["type"] == "place_id":
        if not isinstance(val, str) or val not in known_places:
            return f"{key}: {val!r} is not a known place"
    return None


def validate(msg, known_places=()):
    """-> (ok: bool, errors: [str]). known_places: valid place ids
    for the priority_place amendment."""
    if not isinstance(msg, dict):
        return False, ["message is not an object — the channel "
                       "carries verb objects, not text"]
    verb = msg.get("verb")
    if not isinstance(verb, str) or verb not in _VERB_KEYS:
        return False, [f"unknown or missing verb: {verb!r} "
                       f"(channel verbs: PAUSE, RECALL, AMEND)"]
    errors = []
    extra = set(msg) - _VERB_KEYS[verb]
    if extra:
        errors.append(f"keys outside the {verb} schema: "
                      f"{sorted(extra)} — steering rides in extra "
                      f"keys, so extra keys are rejected")
    if verb in ("PAUSE", "RECALL"):
        reason = msg.get("reason")
        if reason is not None and (not isinstance(reason, str)
                                   or len(reason) > _MAX_REASON):
            errors.append("reason must be a short string")
    if verb == "AMEND":
        amd = msg.get("amendments")
        if not isinstance(amd, dict) or not amd:
            errors.append("AMEND requires a non-empty amendments "
                          "object")
        else:
            for k, v in amd.items():
                if k not in ENVELOPE:
                    errors.append(f"{k}: not an amendable parameter "
                                  f"(envelope: {sorted(ENVELOPE)})")
                else:
                    e = _check_value(k, v, set(known_places))
                    if e:
                        errors.append(e)
    return (not errors), errors
