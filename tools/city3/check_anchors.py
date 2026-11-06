"""Validate the generated rooms: props inside their building, seat/stand anchors on open floor, none sharing a stand point, facing consistent."""
import json, math, sys
rooms={r["id"]:r for r in json.load(open("out/interiors/index.json"))}
anchors=json.load(open("out/hero-anchors.json"))["anchors"]
T=0.3; issues=[]
for rid,r in rooms.items():
    x0,z0,x1,z1=r["rect"]; lay=json.load(open(f"out/interiors/{rid}.json"))
    for p in lay["props"]:
        if not (x0-0.05<p[1]<x1+0.05 and z0-0.05<p[3]<z1+0.05): issues.append((rid,"prop outside building",p[0],round(p[1],1),round(p[3],1)))
by={}
for a in anchors: by.setdefault(a["building"],[]).append(a)
for rid,lst in by.items():
    x0,z0,x1,z1=rooms[rid]["rect"]
    for s in lst:
        ax,az=s["approach"]
        if not (x0+T+0.3<ax<x1-T-0.3 and z0+T+0.3<az<z1-T-0.3): issues.append((s["id"],"approach near/outside wall"))
        for o in lst:
            if o is s: continue
            if math.dist(s["approach"],o["seat"])<0.45: issues.append((s["id"],"approach on seat "+o["id"]))
            if o["id"]>s["id"] and math.dist(s["approach"],o["approach"])<0.4: issues.append((s["id"],"shares stand point with "+o["id"]))
        fx,fz=math.sin(s["facing"]),math.cos(s["facing"]); vx,vz=ax-s["seat"][0],az-s["seat"][1]; dot=(fx*vx+fz*vz)/0.62
        if abs(abs(dot)-1)>0.01 or (dot>0)!=(s["approachSide"]=="front"): issues.append((s["id"],"facing/approach mismatch"))
print(len(rooms),"rooms,",len(anchors),"anchors;",len(issues),"issues")
from collections import Counter
print(Counter(i[1].split(" ")[0]+" "+i[1].split(" ")[1] for i in issues).most_common(6))
for i in issues[:12]: print(" ",i)
sys.exit(1 if issues else 0)
