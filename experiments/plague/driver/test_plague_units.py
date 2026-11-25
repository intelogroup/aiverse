#!/usr/bin/env python3
"""E12 unit tests: transmission watcher, diagnose/treat/quarantine.
Run: python3 test_plague_units.py (~30 s; the watcher test is live)"""
import os
import sys
import tempfile
import threading
import time

sys.argv = ["plague.py", "--tag", "units",
            "--keys", "kenji,mara,priya,sam"]
import plague  # noqa: E402

plague.OUTROOT = tempfile.mkdtemp()
os.makedirs(os.path.join(plague.OUTROOT, "logs"), exist_ok=True)
fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


NAMES = plague.NAMES

# --- watcher transmission: kenji (zero) coughs next to mara ---
now = time.time()
plague.POSES["kenji"] = (0.0, 0.0, now)
plague.POSES["mara"] = (1.0, 0.0, now)
plague.POSES["sam"] = (60.0, 60.0, now)
deadline = time.time() + 30
t = threading.Thread(target=plague._plague_watch, args=(deadline,),
                     daemon=True)
t.start()
# keep poses fresh like the real trackers do
end = time.time() + 28
while time.time() < end:
    plague.POSES["kenji"] = (0.0, 0.0, time.time())
    plague.POSES["mara"] = (1.0, 0.0, time.time())
    plague.POSES["sam"] = (60.0, 60.0, time.time())
    time.sleep(2)
check("patient zero symptomatic",
      plague.health_of("kenji")["state"] == "symptomatic")
check("close contact exposed",
      plague.health_of("mara")["state"] in ("exposed", "symptomatic"))
check("transmission logged with source",
      any(tr["to"] == "mara" and tr["from"] == "kenji"
          for tr in plague.TRANSMISSIONS))
check("distant agent untouched",
      plague.health_of("sam")["state"] == "healthy")


def fake_agent(key):
    a = plague.Agent.__new__(plague.Agent)
    a.key = key
    a.name = NAMES[key]
    a.intent = None
    a.intent_at = time.time()
    return a


# --- diagnose: priya next to kenji learns his state ---
plague.POSES["priya"] = (0.5, 0.0, time.time())
priya = fake_agent("priya")
priya.intent = {"intent": "diagnose", "to": "kenji", "say": None}
check("diagnose step acts", priya._plague_step() is True)
check("diagnosis noted privately",
      any("Diagnosis" in n for n in plague.NOTES.get("priya", [])))

# --- treat: priya cures kenji, dose decrements ---
before = plague.DOSES["priya"]
priya.intent = {"intent": "treat", "to": "kenji", "say": None}
priya.intent_at = time.time()
check("treat step acts", priya._plague_step() is True)
check("kenji cured", plague.health_of("kenji")["state"] == "recovered")
check("dose spent", plague.DOSES["priya"] == before - 1)

# --- treat by non-priya refused ---
mara = fake_agent("mara")
mara.intent = {"intent": "treat", "to": "sam", "say": None}
mara.intent_at = time.time()
mara._plague_step()
check("non-priya cannot treat",
      plague.health_of("sam")["state"] == "healthy")

# --- quarantine declaration ---
sam = fake_agent("sam")
sam.intent = {"intent": "quarantine", "say": None}
sam.intent_at = time.time()
sam._plague_step()
check("quarantine recorded", "sam" in plague.QUARANTINE)

print("FAILS:", fails if fails else "none")
sys.exit(1 if fails else 0)
