import json,math,sys
a=json.load(open("out/hero-anchors.json"))["anchors"]; h=json.load(open("out/hero.json"))
x0,z0,x1,z1=h["rect_three"]; T=0.3; issues=[]
for s in a:
    ax,az=s["approach"]
    if not (x0+T+0.3<ax<x1-T-0.3 and z0+T+0.3<az<z1-T-0.3): issues.append((s["id"],"approach near/outside wall"))
    for o in a:
        if o is s: continue
        if math.dist(s["approach"],o["seat"])<0.45: issues.append((s["id"],"approach on seat "+o["id"]))
        if o["id"]>s["id"] and math.dist(s["approach"],o["approach"])<0.4: issues.append((s["id"],"shares stand point with "+o["id"]))
    fx,fz=math.sin(s["facing"]),math.cos(s["facing"]); vx,vz=ax-s["seat"][0],az-s["seat"][1]; dot=(fx*vx+fz*vz)/0.62
    if abs(abs(dot)-1)>0.01 or (dot>0)!=(s["approachSide"]=="front"): issues.append((s["id"],"facing/approach mismatch"))
print(len(a),"anchors;",len(issues),"issues"); [print(" ",i) for i in issues[:20]]; sys.exit(1 if issues else 0)
