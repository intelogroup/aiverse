import json
P=json.load(open("plan.json"))
T=lambda x,y:(round(x,2),round(-y,2))            # plan (x,y) -> three (x,z)
def fp(r): x0,y0,x1,y1=r; a=T(x0,y1); b=T(x1,y0); return [a[0],a[1],b[0],b[1]]   # [minX,minZ,maxX,maxZ]
fps=[fp(b["inner"]) for b in P["blocks"] if b["kind"]!="park"]
fps+=[fp([s["c"][0]-s["size"][0]/2-0.3,s["c"][1]-s["size"][1]/2-0.3,s["c"][0]+s["size"][0]/2+0.3,s["c"][1]+s["size"][1]/2+0.3]) for s in P["stalls"]]
fps+=[fp(t["rect"]) for t in P["towers"]]
HEAD={"S":0.0,"N":3.14159,"W":-1.5708,"E":1.5708}
lots=[dict(id=l["id"],kind=l["kind"],pos=T(*l["pos"]),heading=HEAD[l["facing"]]) for l in P["lots"]]
L=P["land"]
nav=dict(world="city3",name="Sunstone Bazaar",units="m",ground_y=P["walk_z"],three_axes="x east, z = -blender_y",
         walkable=[-L,-L,L,L],plaza=fp(P["plaza"]),fountain_circle=dict(c=[0,0],r=P["fountain"]["r_out"]+0.5),
         footprints=fps,lots=lots,counts=dict(footprints=len(fps),lots=len(lots)))
import os
if os.path.exists("out/hero.json"): nav["hero"]=json.load(open("out/hero.json"))
json.dump(nav,open("out/city3-nav.json","w"),indent=1); print(nav["counts"])
