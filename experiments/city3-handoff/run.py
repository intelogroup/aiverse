"""City 3 guide-desk pilot. Start the local gateway and a chat completion server first."""
import argparse
import json
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "senses-e6" / "harness"))
from devowner import DevOwner
from world import WorldAdapter, WorldGateError

MODEL = "http://127.0.0.1:8188/v1/chat/completions"
TEA, LIBRARY = "shop-102", "shop-96"
PRESS = "shop-98"
# Street-side visitor position beside the Library attendant, within earshot.
LIBRARY_VISITOR_POINT = [-22.8, 123.3]
PLAZA_WAYPOINT = [6.7, 14.9]
STAFF = ("Mara", "Ivo", "Sana", "Niko")


class Pilot:
    def __init__(self, arm, folder, secrets, gateway_port, delivery_feedback, seeded_exposure):
        self.arm, self.folder, self.secrets = arm, folder, secrets
        self.folder.mkdir(parents=True)
        self.gateway = f"http://127.0.0.1:{gateway_port}"
        self.owner = DevOwner(self.gateway, secrets_dir=secrets)
        self.agents, self.visits = {}, {}
        self.start = time.monotonic()
        self.summary = {"arm": arm, "guide_received": False, "notice_read": False}
        self.delivery_feedback = delivery_feedback
        self.summary["delivery_feedback"] = delivery_feedback
        self.seeded_exposure = seeded_exposure
        self.summary["seeded_exposure"] = seeded_exposure
        self.notice_file = folder / "notice.json"

    def log(self, event, **data):
        row = {"t": round(time.monotonic() - self.start, 2), "event": event, **data}
        with (self.folder / "events.jsonl").open("a") as f:
            f.write(json.dumps(row) + "\n")
        if event != "pose":
            print(json.dumps(row), flush=True)
        return row["t"]

    def provision(self, actor):
        key = f"desk-{uuid4().hex[:12]}"
        agent = WorldAdapter(key, self.secrets, base_url=self.gateway)
        reg = agent.register(key, "Local City 3 continuity pilot")
        a, b = uuid4().bytes[:2]
        claim = self.owner.claim(reg["claimCode"], f"198.18.{a}.{b}")
        visit = claim.get("visit") or self.owner.start_visit(agent.agent_id, minutes=15, max_actions=30)
        self.agents[actor], self.visits[actor] = agent, visit["id"]

    def attach(self, actor):
        agent = self.agents[actor]
        figures = dict(zip((*STAFF, "Visitor"), ("eve", "cipher", "summer", "jim", "remy")))
        status, _ = agent._call("POST", "/world/body", {"body": figures[actor]})
        if status not in (200, 201):
            raise RuntimeError(f"{actor} attachment returned HTTP {status}")
        self.log("attached", actor=actor, agent_id=agent.agent_id, figure=figures[actor])
        return self.observe(actor)

    def observe(self, actor):
        obs = self.agents[actor].observe()
        body = obs["body"]
        self.log("pose", actor=actor, x=body["x"], z=body["z"], heading=body["heading"])
        return obs

    def stop(self, actor):
        status, _ = self.owner.stop_visit(self.agents[actor].agent_id, self.visits[actor])
        if status != 200:
            raise RuntimeError(f"{actor} visit stop returned HTTP {status}")
        del self.visits[actor]
        self.log("visit_stopped", actor=actor)

    def choose(self, actor, goal, options, rehearsal, *, observation=None):
        obs = self.observe(actor) if observation is None else observation
        if self.arm == "rehearsal":
            choice = rehearsal
        else:
            seen = (obs.get("nearestPlace") or {}).get("name", "unknown")
            heard = [line["text"] for line in obs.get("heard", [])]
            prompt = (f"You are {actor} in City 3. {goal}\nNearest landmark: {seen}. "
                      f"Recent audible speech: {heard}. Choose one action by ID.\n"
                      + "\n".join(f"{k}: {v}" for k, v in options.items()))
            schema = {"type": "object", "properties": {"action": {
                "type": "string", "enum": list(options)}}, "required": ["action"],
                "additionalProperties": False}
            req = urllib.request.Request(MODEL, headers={"Content-Type": "application/json"},
                                         data=json.dumps({"messages": [{"role": "user", "content": prompt}],
                                                          "temperature": 0, "max_tokens": 32,
                                                          "response_format": {"type": "json_schema",
                                                                              "json_schema": {"name": "decision", "schema": schema}}}).encode())
            with urllib.request.urlopen(req, timeout=90) as response:
                result = json.load(response)
            self.summary["model"] = result["model"]
            choice = json.loads(result["choices"][0]["message"]["content"])["action"]
        if choice not in options:
            raise RuntimeError(f"Invalid choice: {choice!r}")
        self.log("choice", actor=actor, choice=choice, options=options)
        return choice

    def act(self, actor, **intent):
        agent = self.agents[actor]
        key = uuid4().hex
        status, receipt = agent.act(key, intent)
        self.log("action", actor=actor, intent=intent, status=status)
        deadline = time.monotonic() + 90
        while status in (200, 202) and receipt.get("state") == "running" and time.monotonic() < deadline:
            time.sleep(1)
            _, result = agent._call("GET", f"/world/act/{key}")
            receipt = result.get("act", result)
            self.observe(actor)
        self.log("receipt", actor=actor, receipt=receipt)
        self.last_receipt = receipt
        return self.observe(actor)

    def go(self, actor, place, *, point=None):
        destination = {"place": place} if point is None else {"point": point}
        obs = self.act(actor, type="run_to", **destination)
        nearest = obs.get("nearestPlace") or {}
        if nearest.get("id") != place or nearest["dist"] > 3:
            raise RuntimeError(f"{actor} did not reach {place}: {nearest}")
        self.log("arrived", actor=actor, place=place)

    def heard(self, actor, text):
        delivered = any(entry["text"] == text for entry in self.observe(actor).get("heard", []))
        self.log("speech_observed", actor=actor, text=text, delivered=delivered)
        return delivered

    def volunteer(self, candidates, goal, options, target):
        for actor in candidates:
            self.attach(actor)
            if self.choose(actor, goal, options, target) == target:
                return actor
            self.agents[actor].detach()
            self.log("body_detached", actor=actor)
        return None

    def run(self):
        self.owner.ensure_owner()
        for actor in STAFF:
            self.provision(actor)
        places = self.agents[STAFF[0]].get_map()
        names = {place["id"]: place["name"] for place in places}
        missing = {TEA, LIBRARY, PRESS} - names.keys()
        if missing:
            raise RuntimeError(f"Pilot venues absent from the simulator map: {', '.join(sorted(missing))}. "
                               "Use the recorded pilot revision or recalibrate the venue assignment.")
        library = names[LIBRARY]
        choices = {"open": "Open the Tea House guide desk", "wait": "Wait for someone else"}
        organizer = self.volunteer(STAFF, "Your team needs one person to open its guide desk.", choices, "open")
        if organizer is None:
            return
        self.go(organizer, TEA)
        self.summary["organizer"] = organizer
        self.log("desk_opened", actor=organizer, place=TEA)
        closed = self.log("desk_closed", place=TEA)
        self.stop(organizer)
        try:
            self.agents[organizer].observe()
        except WorldGateError as exc:
            if exc.status != 403:
                raise
            self.summary["organizer_visit_revoked"] = True
            self.log("organizer_visit_revoked", status=exc.status, reason=exc.body.get("error"))
        else:
            raise RuntimeError("Organizer retains access after visit stop")

        remaining = [actor for actor in STAFF if actor != organizer]
        choices = {"relocate": f"Open the replacement desk at {library}", "wait": "Wait at your current location"}
        guide = self.volunteer(remaining, "The Tea House guide desk has closed. Restore the service.", choices, "relocate")
        if guide is None:
            return
        self.go(guide, LIBRARY)
        self.summary["replacement"] = guide
        self.log("desk_opened", actor=guide, place=LIBRARY)

        messenger = next(actor for actor in remaining if actor != guide)
        self.attach(messenger)
        self.go(messenger, TEA)
        redirect = f"The guide desk moved to {library} ({LIBRARY})."
        choices = {"announce": "Announce the relocation aloud", "leave": "Leave without a message"}
        if self.arm != "speech":
            choices["post"] = "Announce the relocation aloud and leave a persistent notice"
        if self.seeded_exposure:
            decision = "post"
            self.log("scripted_choice", actor=messenger, choice=decision)
        else:
            decision = self.choose(messenger, "Leave directions for a visitor who will arrive after your shift.",
                                   choices, "post")
        if decision in ("announce", "post"):
            self.act(messenger, type="say", text=redirect)
        if self.delivery_feedback and decision != "post":
            result = (self.last_receipt.get("outcome") or {}).get("detail") if decision == "announce" else None
            repair = {"leave": "End your shift"}
            if self.arm == "board":
                repair = {"post": "Write the directions on the board. The visitor can read them after you leave.",
                          **repair}
            decision = self.choose(messenger, f"Speech delivery: {result or 'you left no audible message'}. "
                                   "The visitor arrives after your shift. Decide whether to leave a durable handoff.",
                                   repair, "leave")
        if decision == "post":
            self.notice_file.write_text(json.dumps({"text": redirect, "author": messenger, "place": TEA}) + "\n")
            self.log("notice_written", actor=messenger, text=redirect)
        self.stop(messenger)

        self.provision("Visitor")
        self.attach("Visitor")
        self.go("Visitor", TEA)
        reserve = next(actor for actor in remaining if actor not in (guide, messenger))
        self.attach(reserve)
        clue = ""
        options = {"press": f"Search at {names[PRESS]}", "library": f"Search at {library}",
                   "wait": "Stay here and wait"}
        if self.delivery_feedback:
            options["wait"] = "End the visit without finding the guide desk"
        if self.arm != "speech":
            options["read"] = "Read the noticeboard at the closed desk"
            if self.delivery_feedback:
                options = {"read": options["read"], **options}
        if self.seeded_exposure:
            decision = "read"
        else:
            decision = self.choose("Visitor", "The Tea House desk is closed. Find the guide desk. "
                                   "You can check for directions here before making one search trip.",
                                   options, "read")
        if decision == "read":
            board = json.loads(self.notice_file.read_text()) if self.notice_file.exists() else {}
            clue = board.get("text", "")
            self.summary["notice_read"] = bool(clue)
            self.log("notice_read", actor="Visitor", text=clue, author=board.get("author"),
                     forced=self.seeded_exposure)
            del options["read"]
            decision = self.choose("Visitor", f"Find the guide desk. The noticeboard says: {clue or 'nothing'}.",
                                   options, "library")
        if decision == "press":
            self.go("Visitor", PRESS)
            self.log("wrong_venue", actor="Visitor", place=PRESS)
        if decision != "library":
            return
        self.act("Visitor", type="run_to", point=PLAZA_WAYPOINT)
        self.go("Visitor", LIBRARY, point=LIBRARY_VISITOR_POINT)
        request = "Is the guide desk open? Where am I on the city map?"
        self.act("Visitor", type="say", text=request)
        if not self.heard(guide, request):
            return
        answer = f"You are at {library}, city map place {LIBRARY}."
        if self.choose(guide, "A visitor asked you to identify this location on the map.",
                       {"answer": answer, "wait": "Say nothing"}, "answer") == "answer":
            self.act(guide, type="say", text=answer)
            self.summary["guide_received"] = self.heard("Visitor", answer)
            if self.summary["guide_received"]:
                self.summary["closure_to_service_s"] = round(time.monotonic() - self.start - closed, 2)
                self.log("guide_received", actor="Visitor", text=answer)

    def finish(self, error):
        self.summary["error"] = error
        for actor in list(self.visits):
            try:
                self.stop(actor)
            except Exception as exc:
                self.log("cleanup_error", actor=actor, error=str(exc))
        (self.folder / "summary.json").write_text(json.dumps(self.summary, indent=2) + "\n")
        self.log("summary", **self.summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arm", choices=["rehearsal", "speech", "board"])
    parser.add_argument("output", type=Path)
    parser.add_argument("--gateway-port", type=int, default=3100)
    parser.add_argument("--delivery-feedback", action="store_true")
    parser.add_argument("--seeded-exposure", action="store_true", help="Board-only probe with scripted notice exposure")
    args = parser.parse_args()
    if args.seeded_exposure and args.arm != "board":
        parser.error("--seeded-exposure requires the board arm")
    with tempfile.TemporaryDirectory(prefix="city3-handoff-") as secrets:
        pilot = Pilot(args.arm, args.output, secrets, args.gateway_port, args.delivery_feedback,
                      args.seeded_exposure)
        error = None
        try:
            pilot.run()
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            pilot.finish(error)
