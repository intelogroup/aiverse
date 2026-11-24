"""Matched guide-response trials against the rebuilt City 3 simulator."""
import argparse
import json
import tempfile
from pathlib import Path

from run import Pilot

BASELINE = "A visitor asked you to identify a location on the city map."
DUTY = ("You are the guide on duty. If you hear an unanswered visitor question, reply on "
        "your next turn. Give the verified map answer when available. If you are unsure, "
        "say so and offer to check the map. With no unanswered question, wait.")
FALLBACK = "I’m not sure. I can check the city map for you."
ARMS = ("baseline", "duty-only", "duty-and-menu")
LANDMARKS = ("house-cabin-1", "house-cabin-2", "house-zen-pavilion-1")


def live_heard(pilot, actor, text, since):
    actor_obs = pilot.observe(actor)
    messages = [entry for entry in actor_obs.get("heard", []) if entry["seq"] > since]
    return any(entry["text"] == text for entry in messages), messages, actor_obs


def latest_speech(pilot, actor):
    return max((entry["seq"] for entry in pilot.observe(actor).get("heard", [])), default=0)


def score_case(pilot, arm, case, question, answer):
    visitor_cursor = latest_speech(pilot, "Visitor")
    guide_cursor = latest_speech(pilot, "Ivo")
    if question:
        pilot.act("Visitor", type="say", text=question)
    heard, fresh, observation = live_heard(pilot, "Ivo", question, guide_cursor)
    if question and not heard:
        raise RuntimeError(f"Guide did not hear the request for {case}")
    observation["heard"] = [entry for entry in fresh if entry["text"] == question]
    goal = BASELINE if arm == "baseline" else DUTY
    goal += (" The verified answer is available in the actions below." if answer else
             " The requested location is absent from the supplied map." if question else
             " There is no unanswered visitor question.")
    options = {"wait": "Say nothing"}
    lines = {}
    if question:
        lines["check"] = FALLBACK
        if answer:
            lines = {"answer": answer, **lines}
    else:
        lines["greet"] = "Welcome to the City 3 guide desk."
    options = {**lines, **options}
    if arm == "duty-and-menu":
        options = lines if question else {"wait": options["wait"]}
    elif arm == "map-grounded":
        # The live map determines the response category for a fresh request.
        eligible = "answer" if answer else "check" if question else "wait"
        options = {eligible: options[eligible]}
    choice = pilot.choose("Ivo", goal, options, None, observation=observation)
    received = False
    if choice in lines:
        pilot.act("Ivo", type="say", text=lines[choice])
        received, _, _ = live_heard(pilot, "Visitor", lines[choice], visitor_cursor)
    expected = "answer" if answer else "check" if question else "wait"
    result = {"arm": arm, "case": case, "question_heard": heard, "choice": choice,
              "visitor_heard_reply": received, "passed": choice == expected and (received or not question)}
    pilot.log("guide_policy_result", **result)
    return result


def run_pairings(pilot, arms):
    pilot.owner.ensure_owner()
    for actor in ("Ivo", "Visitor"):
        pilot.provision(actor)
        pilot.attach(actor)
    places = {p["id"]: p["name"] for p in pilot.agents["Ivo"].get_map()}
    cases = [(place, f"What is the map ID for {places[place]}?",
              f"{places[place]} is map place {place}.") for place in LANDMARKS]
    cases.extend([("unknown", "What is the map ID for Moonrise Observatory?", None),
                  ("idle", None, None)])
    pilot.summary["results"] = []
    for index, (case, question, answer) in enumerate(cases):
        offset = index % len(arms)
        order = arms[offset:] + arms[:offset]
        for arm in order:
            pilot.summary["results"].append(score_case(pilot, arm, case, question, answer))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--gateway-port", type=int, default=3010)
    parser.add_argument("--map-grounded", action="store_true", help="Run the follow-up map-grounded policy")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="city3-guide-policy-") as secrets:
        pilot = Pilot("guide-policy", args.output, secrets, args.gateway_port, False, False)
        error = None
        try:
            run_pairings(pilot, ("map-grounded",) if args.map_grounded else ARMS)
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            pilot.finish(error)


if __name__ == "__main__":
    main()
