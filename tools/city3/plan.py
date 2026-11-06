"""City 3 'Sunstone Bazaar' — layout plan. Pure python, seeded.
Plan coords: x east, y north, metres, origin = plaza centre (Blender world coords).
three.js coords: x_t = x, z_t = -y (glTF export flips Blender Y to -Z)."""
import json, random, math
rng = random.Random(30330)
LAND = 180.0
WALK_Z = 0.2            # every walkable surface sits flush at this height
SIDEWALK = 2.5
LINES = [(-130,10),(-65,10),(0,20),(65,10),(130,10)]   # (centre,width) both axes
edges = [-LAND]; streets = []
for c,w in LINES:
    edges += [c-w/2, c+w/2]; streets.append((c-w/2, c+w/2, w))
edges.append(LAND)
BL = [(edges[i], edges[i+1]) for i in range(0, len(edges), 2)]   # 6 block intervals per axis
PLAZA = (-60.0, -60.0, 60.0, 60.0)

def kind_of(i, j):
    if i in (2,3) and j in (2,3): return "plaza"
    if (i,j) in ((0,0),(5,5)): return "park"
    if (i,j) == (3,4): return "hall"          # Great Souk Hall, north of the plaza
    if (i,j) == (4,1): return "citadel"       # tower block SE
    if 1 <= i <= 4 and 1 <= j <= 4: return "market"
    return "edge"

blocks = []
for i,(x0,x1) in enumerate(BL):
    for j,(y0,y1) in enumerate(BL):
        k = kind_of(i,j)
        if k == "plaza": continue
        blocks.append(dict(i=i,j=j,kind=k,rect=[x0,y0,x1,y1]))

def split(length, lo, hi):
    out=[]; rem=length
    while rem > hi + lo:
        w = rng.choice([x for x in (8,12,16,20) if lo<=x<=hi]); out.append(w); rem -= w
    out.append(rem); return out

PAL = ["sand","ochre","white","rose","blue"]
def floors_for(kind, dist):
    if kind=="market": base = 5 if dist<70 else 4
    elif kind=="citadel": base = 6
    else: base = 3
    return max(2, base + rng.choice([-1,0,0,1]))

buildings=[]; courtyards=[]; parks=[]; halls=[]
for b in blocks:
    x0,y0,x1,y1 = b["rect"]; k=b["kind"]
    bx0,by0,bx1,by1 = x0+SIDEWALK, y0+SIDEWALK, x1-SIDEWALK, y1-SIDEWALK   # inside the sidewalk band
    b["inner"]=[bx0,by0,bx1,by1]
    if k=="park": parks.append(dict(block=(b["i"],b["j"]), rect=[bx0,by0,bx1,by1])); continue
    if k=="hall":
        halls.append(dict(rect=[bx0+4,by0+4,bx1-4,by1-4], h=14.0)); b["hall"]=True; continue
    d = 12.0 if k!="edge" else 10.0
    cx=(bx0+bx1)/2; cy=(by0+by1)/2
    dist = math.hypot(cx,cy)
    courtyards.append(dict(block=(b["i"],b["j"]), rect=[bx0+d,by0+d,bx1-d,by1-d]))
    def add(rx0,ry0,rx1,ry1,face):
        # face = the street-facing side (outward) of this lot: 'S','N','W','E'
        n = floors_for(k, dist)
        buildings.append(dict(block=(b["i"],b["j"]), rect=[rx0,ry0,rx1,ry1], floors=n,
            mat=rng.choice(PAL), roof=("flat" if (k=="citadel" or rng.random()<0.3) else "pitched"), face=face))
    # south & north rows span full width; west & east fill the gap between them
    for side,(yy0,yy1,face) in (("S",(by0,by0+d,"S")),("N",(by1-d,by1,"N"))):
        x=bx0
        for w in split(bx1-bx0, 8, 20):
            add(x,yy0,x+w,yy1,face); x+=w
    y=by0+d
    for side,(xx0,xx1,face) in (("W",(bx0,bx0+d,"W")),("E",(bx1-d,bx1,"E"))):
        yy=by0+d
        for w in split((by1-d)-(by0+d), 8, 20):
            add(xx0,yy,xx1,yy+w,face); yy+=w

# landmark tower (citadel block centre) and plaza tower+fountain
towers=[dict(rect=[-3.2,-3.2,3.2,3.2], h=38.0, kind="clock")]
cb=[b for b in blocks if b["kind"]=="citadel"][0]["inner"]
ccx=(cb[0]+cb[2])/2; ccy=(cb[1]+cb[3])/2
towers.append(dict(rect=[ccx-4,ccy-4,ccx+4,ccy+4], h=30.0, kind="minaret"))
fountain=dict(c=[0,0], r_out=10.0, r_in=6.0)

# bazaar stalls: 4 quadrants x 5 cols x 4 rows, aisles kept clear around tower and avenues
stalls=[]
CANOPY=["teal","saffron","crimson","cream"]
for sx in (-1,1):
    for sy in (-1,1):
        for cx_ in (17,26,35,44,53):
            for cy_ in (18,30,42,54):
                if math.hypot(cx_,cy_) < 17: continue
                x=sx*cx_; y=sy*cy_
                stalls.append(dict(c=[x,y], size=[4.0,3.0], canopy=rng.choice(CANOPY),
                                   facing=("N" if sy<0 else "S")))
# lamps & trees along street edges
lamps=[]; trees=[]
for c,w in LINES:
    for t in range(-170,171,25):
        for off in (-(w/2-0.8), (w/2-0.8)):
            lamps.append([c+off, t]); lamps.append([t, c+off])
for b in blocks:
    if b["kind"]=="park":
        x0,y0,x1,y1=b["inner"]
        for _ in range(26):
            for _try in range(20):
                tx=rng.uniform(x0+3,x1-3); ty=rng.uniform(y0+3,y1-3)
                if all(math.hypot(tx-a,ty-bb)>7 for a,bb in trees): trees.append([tx,ty]); break
for cd in courtyards:
    x0,y0,x1,y1=cd["rect"]
    for _ in range(rng.choice([1,2,2,3])):
        trees.append([rng.uniform(x0+3,x1-3), rng.uniform(y0+3,y1-3)])

# room lots (the contract the console reads): stalls + street-facing shop doors + the hall
lots=[]
for n,s in enumerate(stalls): lots.append(dict(id=f"stall-{n}",kind="stall",pos=s["c"],facing=s["facing"]))
FACE_VEC={"S":(0,-1),"N":(0,1),"W":(-1,0),"E":(1,0)}
for n,bd in enumerate(buildings):
    blk=[b for b in blocks if (b["i"],b["j"])==bd["block"]][0]
    if blk["kind"]!="market": continue
    x0,y0,x1,y1=bd["rect"]; fx,fy=FACE_VEC[bd["face"]]
    lots.append(dict(id=f"shop-{n}",kind="shopfront",pos=[(x0+x1)/2+fx*(abs(x1-x0)/2 if fx else 0),(y0+y1)/2+fy*(abs(y1-y0)/2 if fy else 0)],facing=bd["face"]))
hx0,hy0,hx1,hy1=halls[0]["rect"]; lots.append(dict(id="hall-0",kind="hall",pos=[(hx0+hx1)/2,hy0],facing="S"))

plan=dict(land=LAND,walk_z=WALK_Z,sidewalk=SIDEWALK,streets=[dict(c=(a+b)/2,w=w) for a,b,w in streets],
          blocks=blocks,plaza=PLAZA,buildings=buildings,courtyards=courtyards,parks=parks,halls=halls,
          towers=towers,fountain=fountain,stalls=stalls,lamps=lamps,trees=trees,lots=lots)
json.dump(plan, open("plan.json","w"))
print("blocks",len(blocks),"buildings",len(buildings),"stalls",len(stalls),"lamps",len(lamps),"trees",len(trees),"lots",len(lots))
