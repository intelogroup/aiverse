#!/usr/bin/env python3
"""Generate items.json for the Collect+Bag hunt from validated points.
All outdoor points route-validated on the city3@1914cb5a navmesh
(itemCheck.ts, 2026-11-24: every candidate endGap 0.00 except
egg-bazaar-03 at 1.44 m — inside the 2.5 m collect radius).
Interior points use room centres / in-rect offsets from interiors/index.json.
Stall items sit at the stall STAND points (where an agent actually stands)."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
places = json.load(open(os.path.join(
    HERE, "..", "..", "..", "..", "..", "..", "..",
    "tmp-pip/collect-bag/repo/apps/console/public/assets/city3-places.json"))
) if False else json.load(open(
    "/home/hatch/tmp-pip/collect-bag/repo/apps/console/public/assets/city3-places.json"))
stand = {p["id"]: p["stand"] for p in places}

ITEMS = [
    # --- the SET (5 relics, announced at start; one inside a cabin) ---
    {"id": "relic-sun", "name": "Sun Relic", "set": True,
     "x": -20.0, "z": 83.255, "room": "Stone Cabin", "place": "house-cabin-1",
     "placeLabel": "Stone Cabin (inside)"},
    {"id": "relic-leaf", "name": "Leaf Relic", "set": True,
     "x": -24.225, "z": -114.63, "room": "Zen Tea Pavilion",
     "place": "house-zen-pavilion-1", "placeLabel": "Zen Tea Pavilion (inside)"},
    {"id": "relic-ember", "name": "Ember Relic", "set": True,
     "x": -25.0, "z": -78.5, "room": "Matchmaker's Tea House", "place": "shop-102",
     "placeLabel": "Tea House (inside)"},
    {"id": "relic-star", "name": "Star Relic", "set": True,
     "x": 35.0, "z": -76.5, "room": None, "place": "hall-0",
     "placeLabel": "Great Hall"},
    {"id": "relic-moon", "name": "Moon Relic", "set": True,
     "x": -100.0, "z": -68.5, "room": None, "place": "egg-bazaar-06",
     "placeLabel": "western market lane (egg 6)"},
    # --- cabin / pavilion interiors (2 per house) ---
    {"id": "cabin1-wolf", "name": "Carved Wolf",
     "x": -24.5, "z": 82.0, "room": "Stone Cabin", "place": "house-cabin-1",
     "placeLabel": "Stone Cabin (inside)"},
    {"id": "cabin2-pearl", "name": "Tide Pearl",
     "x": -80.745, "z": 30.0, "room": "Lakeside Cabin", "place": "house-cabin-2",
     "placeLabel": "Lakeside Cabin (inside)"},
    {"id": "cabin2-flute", "name": "Driftwood Flute",
     "x": -79.5, "z": 33.5, "room": "Lakeside Cabin", "place": "house-cabin-2",
     "placeLabel": "Lakeside Cabin (inside)"},
    {"id": "zen-bell", "name": "Zen Bell",
     "x": -22.5, "z": -116.5, "room": "Zen Tea Pavilion",
     "place": "house-zen-pavilion-1", "placeLabel": "Zen Tea Pavilion (inside)"},
    # --- tea house interior ---
    {"id": "tea-teapot", "name": "Jade Teapot",
     "x": -31.0, "z": -76.0, "room": "Matchmaker's Tea House", "place": "shop-102",
     "placeLabel": "Tea House (inside)"},
    # --- easter eggs (outdoor) ---
    {"id": "egg-01", "name": "Fountain Egg", "x": -12.6, "z": 1.0,
     "room": None, "place": "egg-bazaar-01", "placeLabel": "fountain ring"},
    {"id": "egg-02", "name": "Tea-Approach Egg", "x": -30.1, "z": -70.5,
     "room": None, "place": "egg-bazaar-02", "placeLabel": "Tea House approach"},
    {"id": "egg-03", "name": "Fruit-Stall Egg", "x": -27.2, "z": -41.6,
     "room": None, "place": "egg-bazaar-03", "placeLabel": "fruit-stall displays"},
    {"id": "egg-04", "name": "Press Egg", "x": -30.2, "z": 70.9,
     "room": None, "place": "egg-bazaar-04", "placeLabel": "near Kronikler Press"},
    {"id": "egg-05", "name": "East-Plaza Egg", "x": 42.0, "z": 10.0,
     "room": None, "place": "egg-bazaar-05", "placeLabel": "eastern plaza edge"},
    # --- stall scatter (at stand points) ---
    {"id": "stall-kettle", "name": "Copper Kettle",
     "x": stand["stall-27"][0], "z": stand["stall-27"][1],
     "room": None, "place": "stall-27", "placeLabel": "stall-27"},
    {"id": "stall-orb", "name": "Glass Orb",
     "x": stand["stall-79"][0], "z": stand["stall-79"][1],
     "room": None, "place": "stall-79", "placeLabel": "stall-79"},
    {"id": "stall-key", "name": "Brass Key",
     "x": stand["stall-53"][0], "z": stand["stall-53"][1],
     "room": None, "place": "stall-53", "placeLabel": "stall-53"},
    {"id": "stall-dice", "name": "Ivory Dice",
     "x": stand["stall-40"][0], "z": stand["stall-40"][1],
     "room": None, "place": "stall-40", "placeLabel": "stall-40"},
    {"id": "stall-lantern", "name": "Iron Lantern",
     "x": stand["stall-13"][0], "z": stand["stall-13"][1],
     "room": None, "place": "stall-13", "placeLabel": "stall-13"},
]
out = os.path.join(HERE, "items.json")
json.dump(ITEMS, open(out, "w"), indent=1)
print(f"{len(ITEMS)} items -> {out}")
print("set:", [i["id"] for i in ITEMS if i.get("set")])
print("interior:", [i["id"] for i in ITEMS if i.get("room")])
