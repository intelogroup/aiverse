import bpy, json, math, os, random, sys
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from kit import *
import kit, details, hero, press, assets_kit
from details import *
P=json.load(open(f"{HERE}/plan.json")); rng=random.Random(77)
Z=P["walk_z"]; L=P["land"]; GH=4.2; FH=3.5
bpy.ops.wm.read_factory_settings(use_empty=True)
# ---------------- materials ----------------
TEX=f"{HERE}/tex"; MATS={}
def make_mat(name,img,rough=0.9,emit=False,strength=0.0,alpha=None,base=None):
    m=bpy.data.materials.new(name); m.use_nodes=True; nt=m.node_tree
    for n in list(nt.nodes):
        if n.type not in ("OUTPUT_MATERIAL","BSDF_PRINCIPLED"): nt.nodes.remove(n)
    b=nt.nodes["Principled BSDF"]; b.inputs["Roughness"].default_value=rough; b.inputs["Metallic"].default_value=0.0
    if img:
        t=nt.nodes.new("ShaderNodeTexImage"); t.image=bpy.data.images.load(f"{TEX}/{img}.jpg"); t.extension="REPEAT"
        nt.links.new(t.outputs["Color"],b.inputs["Base Color"])
        if emit: nt.links.new(t.outputs["Color"],b.inputs["Emission Color"]); b.inputs["Emission Strength"].default_value=strength
    if base: b.inputs["Base Color"].default_value=base
    # Single-sided by default: every surface that must read from both sides is emitted twice with
    # opposite windings (shutters, signs, flags, awnings, newsprint). Left double-sided, those pairs
    # z-fight and printed sheets show mirrored text. Glass stays double-sided.
    m.use_backface_culling = alpha is None
    if alpha is not None:
        b.inputs["Alpha"].default_value=alpha
        for attr,val in (("surface_render_method","BLENDED"),("blend_method","BLEND")):
            try: setattr(m,attr,val)
            except Exception: pass
    return m
for k in ("sand","ochre","white","rose","blue"): MATS[f"facade_{k}"]=make_mat(f"Facade_{k}",f"facade_{k}",0.92)
for n,r in (("roof_tile",0.85),("roof_flat",0.95),("cobble",0.88),("sidewalk",0.9),("road_plain",0.9),("road_narrow",0.9),("road_avenue",0.9),("grass",1.0),("courtyard",0.95),("awning",0.8),("palette",0.8),("shutters",0.7),("signs",0.6),("blades",0.6),("interior_wall",0.95),("wood_floor",0.7),("rug",0.95),("newsprint",0.9)):
    MATS[n]=make_mat(n,n,r)
MATS["water"]=make_mat("water","palette",0.45); MATS["lamp_glow"]=make_mat("lamp_glow","palette",0.5,emit=True,strength=3.0)
MATS["glass"]=make_mat("glass",None,0.05,alpha=0.22,base=(0.72,0.86,0.95,1.0))
# ---------------- flat surfaces & roads ----------------
def flat(b,x0,y0,x1,y1,z,tile): mb(b).quad((x0,y0,z),(x1,y0,z),(x1,y1,z),(x0,y1,z),(x0/tile,y0/tile),(x1/tile,y0/tile),(x1/tile,y1/tile),(x0/tile,y1/tile),(0,0,1))
px0,py0,px1,py1=P["plaza"]
def in_plaza(r): return r[0]>=px0-0.01 and r[1]>=py0-0.01 and r[2]<=px1+0.01 and r[3]<=py1+0.01
def pt_in_plaza(x,y): return px0<=x<=px1 and py0<=y<=py1
for b in P["blocks"]: flat("sidewalk",*b["rect"],Z,4.0)
flat("cobble",*P["plaza"],Z,6.0)
for pk in P["parks"]: flat("grass",*pk["rect"],Z+0.06,8.0)
for cy in P["courtyards"]: flat("courtyard",*cy["rect"],Z+0.1,4.0)
SEG=[(-L,-135),(-125,-70),(-60,-10),(10,60),(70,125),(135,L)]
for s in P["streets"]:
    c,w=s["c"],s["w"]; name="road_avenue" if w>=20 else "road_narrow"
    for (a,bb) in SEG:
        r=(c-w/2,a,c+w/2,bb)
        if not in_plaza(r): mb(name).quad((r[0],a,Z),(r[2],a,Z),(r[2],bb,Z),(r[0],bb,Z),(a/8,0),(a/8,1),(bb/8,1),(bb/8,0),(0,0,1))
        r2=(a,c-w/2,bb,c+w/2)
        if not in_plaza(r2): mb(name).quad((a,r2[1],Z),(bb,r2[1],Z),(bb,r2[3],Z),(a,r2[3],Z),(a/8,0),(bb/8,0),(bb/8,1),(a/8,1),(0,0,1))
INTS=[]
for sx in P["streets"]:
    for sy in P["streets"]:
        r=(sx["c"]-sx["w"]/2,sy["c"]-sy["w"]/2,sx["c"]+sx["w"]/2,sy["c"]+sy["w"]/2)
        if not in_plaza(r): flat("road_plain",*r,Z,8.0); INTS.append(r)
def stripe(x0,y0,x1,y1): pquad("palette",(x0,y0,Z+0.05),(x1,y0,Z+0.05),(x1,y1,Z+0.05),(x0,y1,Z+0.05),"white",(0,0,1))
for (ix0,iy0,ix1,iy1) in INTS:                                              # zebra crossings on all four arms
    for x in [ix0+0.7+0.95*k for k in range(int((ix1-ix0-1.4)/0.95)+1)]:
        for (ya,yb) in ((iy0-4.0,iy0-1.5),(iy1+1.5,iy1+4.0)):
            if not pt_in_plaza(x,(ya+yb)/2): stripe(x,ya,x+0.5,yb)
    for y in [iy0+0.7+0.95*k for k in range(int((iy1-iy0-1.4)/0.95)+1)]:
        for (xa,xb) in ((ix0-4.0,ix0-1.5),(ix1+1.5,ix1+4.0)):
            if not pt_in_plaza((xa+xb)/2,y): stripe(xa,y,xb,y+0.5)
# ---------------- buildings ----------------
block_kind={(b["i"],b["j"]):b["kind"] for b in P["blocks"]}
SUB={k:tuple(v) for k,v in ATL.items()}
def wallq(mat,fr,s0,s1,z0,z1,sub,u1=1.0):
    v0,v1=SUB[sub]; tq(mat,[fr.p(s0,0,z0),fr.p(s1,0,z0),fr.p(s1,0,z1),fr.p(s0,0,z1)],[(0,v0),(u1,v0),(u1,v1),(0,v1)],fr.o(0,1))
# Hero buildings: furnished ground floors with real openings. Each one's upper floors, roof and
# ceiling go to a "<Upper>_*" group so the console can cut the building away.
HERO_SPECS=[dict(id="tea",name="Matchmaker's Tea House",block=(2,4),face="S",sign=3,blade=0,door="door_green",fn=hero.interior,upper="TeaUpper"),
            dict(id="press",name="Kronikler Press",block=(2,1),face="N",sign=2,blade=2,door="door_blue",fn=press.interior,upper="PressUpper")]
HERO_OF={}
for spec in HERO_SPECS:
    cands=[b for b in P["buildings"] if tuple(b["block"])==spec["block"] and b["face"]==spec["face"]]
    if cands: HERO_OF[id(max(cands,key=lambda b:b["rect"][2]-b["rect"][0]))]=spec
HERO_INFO={}
def building(bd,idx):
    global HERO_INFO
    rnd=random.Random(5000+idx); r=bd["rect"]; n=bd["floors"]; mat=f"facade_{bd['mat']}"
    kind=block_kind[tuple(bd["block"])]; market=kind in ("market","citadel"); spec=HERO_OF.get(id(bd)); is_hero=spec is not None
    style="B" if rnd.random()<0.35 else "A"; cell=rnd.randrange(8); H=GH+(n-1)*FH
    UG=spec["upper"] if is_hero else None
    for side in ("S","E","N","W"):
        fr,length=frame_for(r,side,Z); face=(side==bd["face"]); bays=max(1,round(length/4.0)); bw=length/bays
        if face:
            db=bays//2; doorpos=None
            if is_hero:
                D_=bd["rect"][3]-bd["rect"][1] if side in ("S","N") else bd["rect"][2]-bd["rect"][0]
                HERO_INFO[spec["id"]]={"fr":fr,"W":length,"D":D_,"bd":bd,"spec":spec}; kit.CUR[0]=spec["id"]
                dp=hero.hero_ground(bd,fr,length,D_,GH,rnd,SUB["plain"],sign=spec["sign"],blade_k=spec["blade"],door_col=spec["door"],interior_fn=spec["fn"]); HERO_INFO[spec["id"]]["door_u"]=dp
            else:
                for k in range(bays):
                    s0=k*bw; s1=s0+bw; c=(s0+s1)/2
                    if k==db:
                        wallq(mat,fr,s0,s1,0,GH,"plain"); door(fr,c,rnd,market)
                        if market and rnd.random()<0.8: blade(fr,c-1.7,3.0,rnd.randrange(16))
                    elif market:
                        wallq(mat,fr,s0,s1,0,GH,"shopB" if rnd.random()<0.7 else "shopA")
                        fascia(fr,s0+0.25,s1-0.25,3.35,4.15,rnd.randrange(16)) if rnd.random()<0.75 else None
                        if rnd.random()<0.7: awning_bay(fr,s0+0.3,s1-0.3,0,rnd.randrange(4))
                        fbox(fr,s0,s1,0,0.06,0,0.55,"stone")
                    else:
                        wallq(mat,fr,s0,s1,0,GH,"upA"); window(fr,c,1.2*bw/4,0.95*GH/FH,rnd,"A",cell,tall=GH/FH)
            with grp(UG):
                for f in range(1,n):
                    for k in range(bays):
                        s0=k*bw; s1=s0+bw; c=(s0+s1)/2; sub="upB" if (style=="B" and f%2==1) else "upA"
                        wallq(mat,fr,s0,s1,GH+(f-1)*FH,GH+f*FH,sub)
                        window(fr,c,1.2*bw/4 if sub=="upA" else 1.24*bw/4,GH+(f-1)*FH+(0.95 if sub=="upA" else 0.15),rnd,"B" if sub=="upB" else "A",cell)
            # sidewalk dressing at the bay boundaries
            for k in range(1,bays):
                if rnd.random()<0.5:
                    x,y=fr.xy(k*bw,1.3); pick=rnd.random()
                    if pick<0.3: planter(x,y,Z,rnd)
                    elif pick<0.5: barrel(x,y,Z)
                    elif pick<0.65: crates(x,y,Z,rnd)
                    elif pick<0.75: bin_(x,y,Z)
                    elif pick<0.9 and bw>3.8: bench(*fr.xy(k*bw,0.6),Z,abs(fr.n[1])<0.5)
            if not is_hero and rnd.random()<0.7:
                for sg in (-1,1): x,y=fr.xy(db*bw+bw/2+sg*1.9,0.9); planter(x,y,Z,rnd,big=True) if rnd.random()<0.6 else None
        else:
            wallq(mat,fr,0,length,0,GH,"upA",u1=bays)
            with grp(UG):
                for f in range(1,n): wallq(mat,fr,0,length,GH+(f-1)*FH,GH+f*FH,"upA",u1=bays)
    with grp(UG):
        e=0.28; cr=(r[0]-e,r[1]-e,r[2]+e,r[3]+e)
        for side in ("S","E","N","W"):
            fr,length=frame_for(cr,side,Z)
            pquad("palette",fr.p(0,0,H-0.55),fr.p(length,0,H-0.55),fr.p(length,0,H),fr.p(0,0,H),"stone_lt",fr.o(0,1))
            pquad("palette",fr.p(0,0,H-0.55),fr.p(length,0,H-0.55),fr.p(length,-e,H-0.55),fr.p(0,-e,H-0.55),"stone",(0,0,-1))
        top=Z+H
        if bd["roof"]=="flat":
            x0,y0,x1,y1=cr; mb("roof_flat").quad((x0,y0,top),(x1,y0,top),(x1,y1,top),(x0,y1,top),(x0/4,y0/4),(x1/4,y0/4),(x1/4,y1/4),(x0/4,y1/4),(0,0,1))
            if rnd.random()<0.5:
                cx=(x0+x1)/2+rnd.uniform(-2,2); cy=(y0+y1)/2+rnd.uniform(-2,2); pbox(cx-1,cy-1,cx+1,cy+1,top,top+1.8,"wood"); pbox(cx-1.05,cy-1.05,cx+1.05,cy+1.05,top+1.8,top+2.0,"iron")
        else:
            e2=0.55; x0,y0,x1,y1=r[0]-e2,r[1]-e2,r[2]+e2,r[3]+e2; hx=(x1-x0)/2; hy=(y1-y0)/2; cx=(x0+x1)/2; cy=(y0+y1)/2
            rise=min(hx,hy)*0.55; zr=top+rise
            if hx>=hy: R1=(cx-(hx-hy),cy,zr); R2=(cx+(hx-hy),cy,zr)
            else: R1=(cx,cy-(hy-hx),zr); R2=(cx,cy+(hy-hx),zr)
            A=(x0,y0,top);B=(x1,y0,top);C=(x1,y1,top);D=(x0,y1,top); t=3.0; sl=math.hypot(min(hx,hy),rise)/t
            def face_(E0,E1,T0,T1,axis):
                u=lambda p:(p[0]/t if axis=="x" else p[1]/t)
                c=((E0[0]+E1[0]+T0[0]+T1[0])/4,(E0[1]+E1[1]+T0[1]+T1[1])/4); out=(c[0]-cx,c[1]-cy,0.6)
                mb("roof_tile").quad(E0,E1,T1,T0,(u(E0),0),(u(E1),0),(u(T1),sl),(u(T0),sl),out)
            if hx>=hy:
                face_(A,B,R1,R2,"x"); face_(C,D,R2,R1,"x"); mb("roof_tile").tri(B,C,R2,(0,0),(1,0),(0.5,sl),(1,0,0.5)); mb("roof_tile").tri(D,A,R1,(0,0),(1,0),(0.5,sl),(-1,0,0.5))
            else:
                face_(B,C,R1,R2,"y"); face_(D,A,R2,R1,"y"); mb("roof_tile").tri(A,B,R1,(0,0),(1,0),(0.5,sl),(0,-1,0.5)); mb("roof_tile").tri(C,D,R2,(0,0),(1,0),(0.5,sl),(0,1,0.5))
            if rnd.random()<0.7:                                                  # chimney
                mx=(R1[0]+R2[0])/2+rnd.uniform(-1.2,1.2)*(1 if hx>=hy else 0); my=(R1[1]+R2[1])/2+rnd.uniform(-1.2,1.2)*(0 if hx>=hy else 1)
                pbox(mx-0.45,my-0.45,mx+0.45,my+0.45,top,zr+1.5,"brick"); pbox(mx-0.55,my-0.55,mx+0.55,my+0.55,zr+1.5,zr+1.7,"stone"); pbox(mx-0.3,my-0.3,mx+0.3,my+0.3,zr+1.7,zr+1.8,"ink")
    if is_hero:
        hi=HERO_INFO[spec["id"]]
        with grp(UG): hero.hero_ceiling(hi["fr"],hi["W"],hi["D"],GH)
for i,bd in enumerate(P["buildings"]): building(bd,i)
# ---------------- hall, towers, fountain ----------------
def tall_block(mat,r,floors):
    for side in ("S","E","N","W"):
        fr,length=frame_for(r,side,Z); bays=max(1,round(length/4.0))
        wallq(mat,fr,0,length,0,GH,"shopA",u1=bays)
        for f in range(1,floors): wallq(mat,fr,0,length,GH+(f-1)*FH,GH+f*FH,"upA",u1=bays)
    return Z+GH+(floors-1)*FH
for h in P["halls"]:
    r=h["rect"]; x0,y0,x1,y1=r; top=tall_block("facade_rose",r,2); cx=(x0+x1)/2; rise=7.0; N=16
    pts=[(y0+(y1-y0)*k/N,top+rise*math.sin(math.pi*k/N)) for k in range(N+1)]
    for k in range(N):
        (ya,za),(yb,zb)=pts[k],pts[k+1]; mid=((ya+yb)/2-(y0+y1)/2,((za+zb)/2-top)); out=(0,mid[0],max(mid[1],0.01)*3)
        mb("roof_tile").quad((x0-0.5,ya,za),(x1+0.5,ya,za),(x1+0.5,yb,zb),(x0-0.5,yb,zb),(x0/3,k*2),(x1/3,k*2),(x1/3,k*2+2),(x0/3,k*2+2),out)
    for xe,sg in ((x0-0.5,-1),(x1+0.5,1)):
        for k in range(N):
            (ya,za),(yb,zb)=pts[k],pts[k+1]
            mb("roof_flat").tri((xe,ya,top),(xe,yb,top),(xe,yb,zb),(0,0),(1,0),(1,1),(sg,0,0)); mb("roof_flat").tri((xe,ya,top),(xe,yb,zb),(xe,ya,za),(0,0),(1,1),(0,1),(sg,0,0))
    for bx in [x0+5+k*(x1-x0-10)/5 for k in range(6)]:                       # hanging banners on the south face
        for (zz,cc) in ((9.2,"crimson"),(6.0,"cloth_gold")): pquad("palette",(bx-0.55,y0-0.06,zz-3.1),(bx+0.55,y0-0.06,zz-3.1),(bx+0.55,y0-0.06,zz),(bx-0.55,y0-0.06,zz),"crimson" if zz>8 else "cloth_gold",(0,-1,0)) if zz>8 else None
        pquad("palette",(bx-0.55,y0-0.06,Z+4.5),(bx+0.55,y0-0.06,Z+4.5),(bx+0.55,y0-0.06,Z+8.6),(bx-0.55,y0-0.06,Z+8.6),"crimson",(0,-1,0))
        pquad("palette",(bx-0.55,y0-0.06,Z+4.5),(bx+0.55,y0-0.06,Z+4.5),(bx+0.55,y0-0.06,Z+5.3),(bx-0.55,y0-0.06,Z+5.3),"cloth_gold",(0,-1,0))
        pbox(bx-0.6,y0-0.1,bx+0.6,y0-0.03,Z+8.6,Z+8.7,"wood_dark")
for t in P["towers"]:
    r=t["rect"]; n=int((t["h"]-GH)/FH)+1; top=tall_block("facade_white" if t["kind"]=="clock" else "facade_sand",r,n)
    x0,y0,x1,y1=r; cx=(x0+x1)/2; cy=(y0+y1)/2; e=0.6; pbox(x0-e,y0-e,x1+e,y1+e,top,top+0.7,"stone_lt")
    if t["kind"]=="clock":
        zc=top+0.7; rise=(x1-x0)*1.3
        for (a,bb) in (((x0-e,y0-e),(x1+e,y0-e)),((x1+e,y0-e),(x1+e,y1+e)),((x1+e,y1+e),(x0-e,y1+e)),((x0-e,y1+e),(x0-e,y0-e))):
            mb("roof_tile").tri((a[0],a[1],zc),(bb[0],bb[1],zc),(cx,cy,zc+rise),(0,0),(2,0),(1,3),((a[0]+bb[0])/2-cx,(a[1]+bb[1])/2-cy,0.5))
        zf=Z+t["h"]-6.5                                                       # four glowing clock faces
        for (dx,dy) in ((0,-1),(1,0),(0,1),(-1,0)):
            fx=cx+dx*((x1-x0)/2+0.05); fy=cy+dy*((y1-y0)/2+0.05); hw=1.1
            if dx==0: pbox(fx-hw-0.1,fy-0.06 if dy>0 else fy-0.1,fx+hw+0.1,fy+0.1 if dy>0 else fy+0.06,zf-hw-0.1,zf+hw+0.1,"brass"); pbox(fx-hw,fy-0.08 if dy>0 else fy-0.12,fx+hw,fy+0.12 if dy>0 else fy+0.08,zf-hw,zf+hw,"paper",b="lamp_glow")
            else: pbox(fx-0.1 if dx>0 else fx-0.06,fy-hw-0.1,fx+0.06 if dx>0 else fx+0.1,fy+hw+0.1,zf-hw-0.1,zf+hw+0.1,"brass"); pbox(fx-0.12 if dx>0 else fx-0.08,fy-hw,fx+0.08 if dx>0 else fx+0.12,fy+hw,zf-hw,zf+hw,"paper",b="lamp_glow")
        pbox(cx-0.05,cy-0.05,cx+0.05,cy+0.05,zc+rise,zc+rise+3.0,"gold")
    else:
        zc=top+0.7; R=(x1-x0)/2+0.4; segs=10
        for k in range(segs):
            a0=2*math.pi*k/segs; a1=2*math.pi*(k+1)/segs
            for rings in range(4):
                th0=rings*math.pi/8; th1=(rings+1)*math.pi/8
                pt=lambda a,th:(cx+R*math.cos(th)*math.cos(a),cy+R*math.cos(th)*math.sin(a),zc+R*1.1*math.sin(th))
                pquad("palette",pt(a0,th0),pt(a1,th0),pt(a1,th1),pt(a0,th1),"white" if rings%2==0 else "cream",(math.cos((a0+a1)/2),math.sin((a0+a1)/2),0.4))
        pbox(cx-0.1,cy-0.1,cx+0.1,cy+0.1,zc+R*1.1,zc+R*1.1+3.5,"gold")
f=P["fountain"]; N=32
def ring(ra,rb,z,name):
    for k in range(N):
        a0=2*math.pi*k/N; a1=2*math.pi*(k+1)/N; p=lambda r,a:(r*math.cos(a),r*math.sin(a),z)
        pquad("water" if name=="water" else "palette",p(ra,a0),p(rb,a0),p(rb,a1),p(ra,a1),name,(0,0,1))
def cylwall(r,z0,z1,name):
    for k in range(N):
        a0=2*math.pi*k/N; a1=2*math.pi*(k+1)/N; am=(a0+a1)/2
        pquad("palette",(r*math.cos(a0),r*math.sin(a0),z0),(r*math.cos(a1),r*math.sin(a1),z0),(r*math.cos(a1),r*math.sin(a1),z1),(r*math.cos(a0),r*math.sin(a0),z1),name,(math.cos(am),math.sin(am),0))
cylwall(f["r_out"],Z,Z+0.9,"stone"); cylwall(f["r_in"],Z,Z+0.9,"stone")
ring(f["r_out"],f["r_out"]+0.5,Z+0.9,"stone_lt"); ring(f["r_in"]-0.5,f["r_in"],Z+0.9,"stone_lt"); ring(f["r_in"],f["r_out"],Z+0.6,"water")
for k in range(N):
    a0=2*math.pi*k/N; a1=2*math.pi*(k+1)/N; ptri("palette",(0,0,Z+0.9),(f["r_in"]*math.cos(a0),f["r_in"]*math.sin(a0),Z+0.9),(f["r_in"]*math.cos(a1),f["r_in"]*math.sin(a1),Z+0.9),"stone",(0,0,1))
for k in range(8):                                                           # fountain jets + benches around the basin
    a=2*math.pi*k/8+math.pi/8; x=8.0*math.cos(a); y=8.0*math.sin(a); cyl(x,y,Z+0.6,Z+1.5,0.08,6,"stone_lt",r1=0.05); cyl(x,y,Z+1.5,Z+1.55,0.18,6,"water")
    bx=13.0*math.cos(a); by=13.0*math.sin(a); bench(bx,by,Z,abs(math.cos(a))<0.7)
# ---------------- stalls ----------------
ROW={"teal":0,"saffron":1,"crimson":2,"cream":3}
GOODS=["crimson","gold","leaf","cream","water_deep","trunk_dark","orange","yellow","lime","magenta"]
for s in P["stalls"]:
    cx,cy=s["c"]; w,d=s["size"]; hx,hy=w/2,d/2; z=Z; sg=1 if s["facing"]=="S" else -1
    pbox(cx-hx+0.25,cy-hy+0.2,cx+hx-0.25,cy+hy-0.2,z,z+0.95,"wood"); pbox(cx-hx+0.2,cy-hy+0.15,cx+hx-0.2,cy+hy-0.15,z+0.95,z+1.0,"wood_dark")
    for px_ in (-hx,hx):
        for py_ in (-hy,hy): pbox(cx+px_-0.06,cy+py_-0.06,cx+px_+0.06,cy+py_+0.06,z,z+2.7,"trunk")
    row=ROW[s["canopy"]]; v0=row/4+0.02; v1=(row+1)/4-0.02; hi=z+2.85; lo=z+2.35; yb=cy+sg*(hy+0.4); yf=cy-sg*(hy+0.4)
    for sgn in (1,-1): mb("awning").quad((cx-hx-0.3,yb,hi),(cx+hx+0.3,yb,hi),(cx+hx+0.3,yf,lo),(cx-hx-0.3,yf,lo),(0,v1),(w/2.2,v1),(w/2.2,v0),(0,v0),(0,sgn*sg*-0.45,sgn*0.9))
    for gi in range(5): gx=cx-hx+0.45+gi*0.6; pbox(gx,cy-0.35,gx+0.45,cy+0.35,z+1.0,z+1.0+rng.uniform(0.18,0.34),rng.choice(GOODS))
    if rng.random()<0.5: barrel(cx+sg*0+hx+0.7,cy,z)
# ---------------- lamps, bunting, trees ----------------
for (lx,ly) in P["lamps"]:
    if abs(lx)<58 and abs(ly)<58: continue
    lamp(lx,ly,Z,rng.random()<0.3)
LAMPS=set((round(a,1),round(b,1)) for a,b in P["lamps"])
for s in P["streets"]:                                                       # bunting across the 10 m streets
    if s["w"]>=20: continue
    c,w=s["c"],s["w"]; off=w/2-0.8
    for t in range(-170,171,25):
        if rng.random()<0.45:
            for (a,b) in (((c-off,t),(c+off,t)),((t,c-off),(t,c+off))):
                if (abs(a[0])<58 and abs(a[1])<58) or (abs(b[0])<58 and abs(b[1])<58): continue
                bunting((a[0],a[1],Z+4.6),(b[0],b[1],Z+4.6),rng)
for k in range(8):                                                           # plaza festoon poles + string lights
    a=2*math.pi*k/8+math.pi/8; P0=(22*math.cos(a),22*math.sin(a)); cyl(P0[0],P0[1],Z,Z+6.0,0.09,6,"iron",top=False)
    a2=2*math.pi*(k+1)/8+math.pi/8; P1=(22*math.cos(a2),22*math.sin(a2)); string_lights((P0[0],P0[1],Z+5.9),(P1[0],P1[1],Z+5.9))
def tree(x,y):
    h=rng.uniform(2.0,2.8); pbox(x-0.18,y-0.18,x+0.18,y+0.18,Z,Z+h,"trunk_dark"); R=rng.uniform(1.6,2.3); H=rng.uniform(3.0,4.2); nm=rng.choice(["leaf","leaf_dark"]); k=7
    for i in range(k):
        a0=2*math.pi*i/k; a1=2*math.pi*(i+1)/k; am=(a0+a1)/2; t=(x,y,Z+h+H); b=(x,y,Z+h-0.3); m=(x+R*math.cos(a0),y+R*math.sin(a0),Z+h+H*0.35); m2=(x+R*math.cos(a1),y+R*math.sin(a1),Z+h+H*0.35)
        ptri("palette",m,m2,t,nm,(math.cos(am),math.sin(am),0.5)); ptri("palette",m2,m,b,nm,(math.cos(am),math.sin(am),-0.5))
for (x,y) in P["trees"]: tree(x,y)
# café sets out front of the hero + a few elsewhere handled in hero
if "tea" in HERO_INFO:
    fr=HERO_INFO["tea"]["fr"]; du=HERO_INFO["tea"]["door_u"]
    for sg in (-1,1):
        for dd in (3.0,5.2):
            x,y=fr.xy(du+sg*dd,1.55); umbrella_set(x,y,Z,rng)
# ---------------- land (open-top quay box) + water ----------------
for side,(a,bb) in {"S":((-L,-L),(L,-L)),"E":((L,-L),(L,L)),"N":((L,L),(-L,L)),"W":((-L,L),(-L,-L))}.items():
    o={"S":(0,-1),"E":(1,0),"N":(0,1),"W":(-1,0)}[side]; pquad("palette",(a[0],a[1],-3),(bb[0],bb[1],-3),(bb[0],bb[1],Z),(a[0],a[1],Z),"stone",(o[0],o[1],0))
u=pal_uv("water_deep"); mb("water").quad((-520,-520,-1.2),(520,-520,-1.2),(520,520,-1.2),(-520,520,-1.2),u,u,u,u,(0,0,1))
# ---------------- realise ----------------
NAME={"sidewalk":"Sidewalks","cobble":"PlazaCobble","grass":"Parks","courtyard":"Courtyards","road_avenue":"RoadAvenue","road_narrow":"RoadStreet","road_plain":"RoadJunction","roof_tile":"RoofTile","roof_flat":"RoofFlat","awning":"Awnings","palette":"Props","water":"Water","lamp_glow":"LampGlow","shutters":"Shutters","signs":"Signs","blades":"BladeSigns","interior_wall":"InteriorWalls","wood_floor":"WoodFloor","rug":"Rug","glass":"Glass","newsprint":"Newsprint"}
for key,b in MBS.items():
    g,_,m=key.rpartition("::"); me=bpy.data.meshes.new(key); me.from_pydata(b.v,[],b.f); me.update()
    uvl=me.uv_layers.new(name="UVMap"); uvl.data.foreach_set("uv",[c for tri in b.uv for uv in tri for c in uv])
    nm=NAME.get(m,"B_"+m.replace("facade_","Facade_")); nm=f"{g}_{nm}" if g else nm
    ob=bpy.data.objects.new(nm,me); bpy.context.scene.collection.objects.link(ob); ob.data.materials.append(MATS[m])
print("PROF",{k:v for k,v in sorted(kit.PROF.items(),key=lambda kv:-kv[1])})
print("MESHES",len(MBS),"TRIS",sum(len(b.f) for b in MBS.values()))
print({k:len(b.f) for k,b in sorted(MBS.items(),key=lambda kv:-len(kv[1].f))[:8]})
os.makedirs(f"{HERE}/out",exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/city3.blend")
for o in bpy.data.objects: o.select_set(not o.name.startswith("PressInterior"))     # the press furnishings ship in their own GLB
# Blender 5.2's meshopt path hard-codes the POSITION exponential filter to 12 bits with ONE
# exponent shared by x, y and z (io_scene_gltf2/io/exp/meshopt.py). At x = -37 m that leaves
# ~6 cm of height precision: a rug 4 cm above a floor snapped onto it. Separate exponents and
# 20 bits keep sub-millimetre precision; the decoder reads any mode (exponents are per component).
import io_scene_gltf2.io.exp.meshopt as _meshopt
_meshopt.EXP_FILTER_BITS=20; _meshopt.ENCODE_EXP_SHARED_VECTOR=_meshopt.ENCODE_EXP_SEPARATE
bpy.ops.export_scene.gltf(filepath=f"{HERE}/out/world-city3.glb",export_format="GLB",export_yup=True,export_apply=True,export_image_format="AUTO",export_texcoords=True,export_normals=True,export_cameras=False,export_lights=False,export_draco_mesh_compression_enable=False,export_meshopt_compression_enable=True,use_selection=True)
print("EXPORTED",os.path.getsize(f"{HERE}/out/world-city3.glb")//1024,"KB")
# ---------------- press furnishings: CC0 library assets -> world-city3-press.glb ----------------
BUDGET={"wooden_bookshelf_worn":3000,"book_encyclopedia_set_01":4000,"desk_lamp_arm_01":2000,"vintage_grandfather_clock_01":3000,"drawer_cabinet":2500,
        "vintage_radio_transceiver":2000,"WoodenTable_02":1514,"ArmChair_01":2500,"potted_plant_02":3000,"wooden_crate_01":1500,"vintage_oil_lamp":1500,
        "wall_clock":1000,"binder_notebook":600,"ChairCushioned":4000}
QUAT={"ChairCushioned"}
coll=bpy.data.collections.new("PressAssets"); bpy.context.scene.collection.children.link(coll)
for (bid,key,x,y,z,rz,sc) in kit.PLACEMENTS:
    assets_kit.load(key,BUDGET.get(key,2000),source="quaternius" if key in QUAT else "polyhaven")
    assets_kit.place(key,coll,x,y,z,rz,sc,name=f"PressInterior_{key}")
bpy.context.view_layer.layer_collection.children["AssetLibrary"].exclude=True
for o in bpy.data.objects: o.select_set(o.name.startswith("PressInterior"))
bpy.ops.export_scene.gltf(filepath=f"{HERE}/out/world-city3-press.glb",export_format="GLB",export_yup=True,export_apply=True,export_image_format="JPEG",export_jpeg_quality=82,
    export_texcoords=True,export_normals=True,export_cameras=False,export_lights=False,export_meshopt_compression_enable=True,use_selection=True)
print("PRESS_EXPORTED",os.path.getsize(f"{HERE}/out/world-city3-press.glb")//1024,"KB",{k:(v["tris_raw"],v["tris"]) for k,v in assets_kit.LIB.items()})
CREDITS=[{"asset":k,"source":("https://opengameart.org/content/furniture-low-poly" if v["source"]=="quaternius" else f"https://polyhaven.com/a/{v['id']}"),"license":"CC0"} for k,v in assets_kit.LIB.items()]
json.dump(CREDITS,open(f"{HERE}/out/asset-credits.json","w"),indent=1)
heroes=[]
for hid,hi in HERO_INFO.items():
    fr=hi["fr"]; r=hi["bd"]["rect"]; dx,dy=fr.xy(hi["door_u"],0.0)
    heroes.append({"id":hid,"name":hi["spec"]["name"],"rect_blender":r,"rect_three":[r[0],-r[3],r[2],-r[1]],"center_three":[(r[0]+r[2])/2,-(r[1]+r[3])/2],
        "door_three":[round(dx,2),round(-dy,2)],"front":hi["bd"]["face"],"cutaway_object_prefix":hi["spec"]["upper"]+"_",
        "interior_glb":"world-city3-press.glb" if hid=="press" else None})
json.dump(heroes,open(f"{HERE}/out/heroes.json","w"),indent=1)
json.dump({"units":"m, three.js XZ; heading = atan2(fx, fz)","anchors":kit.ANCHORS},open(f"{HERE}/out/hero-anchors.json","w"),indent=1)
print("ANCHORS",len(kit.ANCHORS),{h:sum(1 for a in kit.ANCHORS if a["building"]==h) for h in HERO_INFO})
