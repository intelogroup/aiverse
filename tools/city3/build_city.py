import bpy, json, math, os, random, sys
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from kit import *
import kit, details, hero, press, rooms, assets_kit, doors
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
# PBR re-skin (Poly Haven CC0 via mtex.py): ground and roofs get normal maps; UV stays 1 unit = tile_m metres, a Mapping node rescales to the scan size.
PBRM=json.load(open(f"{HERE}/pbr_m.json")) if os.path.exists(f"{HERE}/pbr_m.json") else {}
def pbr_override(key,tag,tile_m,rough=None,tint=None):
    if tag not in PBRM: return
    m=bpy.data.materials.new(key); m.use_nodes=True; nt=m.node_tree
    for n in list(nt.nodes):
        if n.type not in ("OUTPUT_MATERIAL","BSDF_PRINCIPLED"): nt.nodes.remove(n)
    bs=nt.nodes["Principled BSDF"]; tc=nt.nodes.new("ShaderNodeTexCoord"); mp=nt.nodes.new("ShaderNodeMapping"); sc=tile_m/PBRM[tag]["size"]; mp.inputs["Scale"].default_value=(sc,sc,1)
    nt.links.new(tc.outputs["UV"],mp.inputs["Vector"])
    d=nt.nodes.new("ShaderNodeTexImage"); d.image=bpy.data.images.load(f"{HERE}/tex_m/{tag}_d.jpg"); d.extension="REPEAT"; nt.links.new(mp.outputs["Vector"],d.inputs["Vector"])
    if tint is None: nt.links.new(d.outputs["Color"],bs.inputs["Base Color"])
    else:                                                                 # per-variant tint: texture x colour via the Mix node (RGBA/MULTIPLY) — the one pattern the glTF exporter folds into baseColorFactor (probed on 5.2.3: legacy MixRGB and channel-math chains both export untinted)
        mx=nt.nodes.new("ShaderNodeMix"); mx.data_type="RGBA"; mx.blend_type="MULTIPLY"; mx.inputs[0].default_value=1.0; mx.inputs[7].default_value=(*tint,1.0)
        nt.links.new(d.outputs["Color"],mx.inputs[6]); nt.links.new(mx.outputs[2],bs.inputs["Base Color"])
    n=nt.nodes.new("ShaderNodeTexImage"); n.image=bpy.data.images.load(f"{HERE}/tex_m/{tag}_n.jpg"); n.image.colorspace_settings.name="Non-Color"; n.extension="REPEAT"; nt.links.new(mp.outputs["Vector"],n.inputs["Vector"])
    nm=nt.nodes.new("ShaderNodeNormalMap"); nt.links.new(n.outputs["Color"],nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"],bs.inputs["Normal"])
    bs.inputs["Roughness"].default_value=PBRM[tag]["rough"] if rough is None else rough
    rp=f"{HERE}/tex_m/{tag}_r.jpg"                                                                 # optional channel-packed map (ambientCG sets): G = roughness, B = metalness, same mapping; wins over the scalars
    if os.path.exists(rp):
        rt=nt.nodes.new("ShaderNodeTexImage"); rt.image=bpy.data.images.load(rp); rt.image.colorspace_settings.name="Non-Color"; rt.extension="REPEAT"; nt.links.new(mp.outputs["Vector"],rt.inputs["Vector"])
        sep=nt.nodes.new("ShaderNodeSeparateColor"); nt.links.new(rt.outputs["Color"],sep.inputs["Color"]); nt.links.new(sep.outputs["Green"],bs.inputs["Roughness"]); nt.links.new(sep.outputs["Blue"],bs.inputs["Metallic"])
    m.use_backface_culling=True; MATS[key]=m
for _k,_t,_s in (("cobble","plaza_setts",6.0),("sidewalk","pave_warm",4.0),("courtyard","pave_warm",4.0),("roof_tile","roof_barrel",3.0),("roof_flat","roof_clay2",4.0)): pbr_override(_k,_t,_s)
for _v,_tint in enumerate(((0.93,0.90,0.90),(1.05,1.01,0.95),(0.96,0.94,1.00),(1.02,0.96,0.88)),1): pbr_override(f"roof_tile_v{_v}","roof_barrel",3.0,tint=_tint)   # per-building tint variants of the barrel tile: subtle value/hue jitter on the shared set, assigned by building index in building()
pbr_override("roof_hall","roof_barrel",1.5)   # market-hall vault: same set at a 5.2 m repeat (hall UVs are true metres/3 after the arc-length rewrite in the halls loop)
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
# Room buildings: every market-block building gets real openings, glazing and a furnished ground floor
# (a template -> a streamed layout). Upper floors stay in the merged meshes; the console cuts a building
# away with a clipping box, so no per-building objects exist.
SIGN_NAMES=["Sage's Library","Fixer's Forge","Kronikler Press","Matchmaker's Tea House","Provokatov Hall","Kova's Spices","Rekinder Lamps","The Golden Scale","Bakery","Apothecary","Ink & Quill","Cloth & Dye","Coffee","Fruit & Fig","Today's Tea","Salt Road Trading"]
TPL_SIGNS={"cafe":[12,8,13,14],"shop":[5,6,7,9,11,15],"library":[0,10],"workshop":[1]}
rr_=random.Random(2026)
TPL_DOORS={"cafe":[1,3,1,2],"shop":[0,1,3,0,2],"library":[4,0,4,3],"workshop":[4,1,4]}      # door style pool per room template (doors.py)
SPECIAL={(2,4,"S"):dict(id="tea",template="tea",sign=3,blade=0,door="door_green",dstyle=2,dno=7,fn=rooms.TEMPLATES["tea"]),
         (2,1,"N"):dict(id="press",template="press",sign=2,blade=2,door="door_blue",fn=press.interior,dstyle=4,dno=21)}
widest={}
for bd in P["buildings"]:
    k=(*tuple(bd["block"]),bd["face"])
    if k in SPECIAL and bd["rect"][2]-bd["rect"][0]+bd["rect"][3]-bd["rect"][1]>widest.get(k,(0,))[0]: widest[k]=(bd["rect"][2]-bd["rect"][0]+bd["rect"][3]-bd["rect"][1],bd)
HERO_OF={}
for idx,bd in enumerate(P["buildings"]):
    if block_kind[tuple(bd["block"])]!="market": continue
    k=(*tuple(bd["block"]),bd["face"])
    if k in SPECIAL and widest[k][1] is bd: spec=dict(SPECIAL[k])
    else:
        t=rr_.choices(["cafe","shop","library","workshop"],[0.3,0.4,0.15,0.15])[0]
        spec=dict(id=f"shop-{idx}",template=t,sign=rr_.choice(TPL_SIGNS[t]),blade=rr_.randrange(16),door=rr_.choice(details.DOORS),fn=rooms.TEMPLATES[t])
        dr_=random.Random(9100+idx); spec["dstyle"]=dr_.choice(TPL_DOORS[t]); spec["dno"]=dr_.randint(1,98)      # own RNG: must not shift rr_ / the per-building streams
    spec["lot"]=f"shop-{idx}"; spec["name"]=SIGN_NAMES[spec["sign"]]; spec["upper"]=None
    HERO_OF[id(bd)]=spec
HERO_INFO={}
def building(bd,idx):
    global HERO_INFO
    rnd=random.Random(5000+idx); r=bd["rect"]; n=bd["floors"]; mat=f"facade_{bd['mat']}"
    kind=block_kind[tuple(bd["block"])]; market=kind in ("market","citadel"); spec=HERO_OF.get(id(bd)); is_hero=spec is not None
    style="B" if rnd.random()<0.35 else "A"; cell=rnd.randrange(8); H=GH+(n-1)*FH
    UG=None
    for side in ("S","E","N","W"):
        fr,length=frame_for(r,side,Z); face=(side==bd["face"]); bays=max(1,round(length/4.0)); bw=length/bays
        if face:
            db=bays//2; doorpos=None
            if is_hero:
                D_=bd["rect"][3]-bd["rect"][1] if side in ("S","N") else bd["rect"][2]-bd["rect"][0]
                HERO_INFO[spec["id"]]={"fr":fr,"W":length,"D":D_,"bd":bd,"spec":spec}; kit.CUR[0]=spec["id"]
                dp=hero.hero_ground(bd,fr,length,D_,GH,rnd,SUB["plain"],sign=spec["sign"],blade_k=spec["blade"],door_col=spec["door"],interior_fn=spec["fn"],door_style=spec["dstyle"],door_no=spec["dno"]); HERO_INFO[spec["id"]]["door_u"]=dp
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
    with grp(UG):                                                             # wall relief: string courses at every floor line + alternating corner quoins
        for side in ("S","E","N","W"):
            fr,length=frame_for(r,side,Z)
            for f in range(1,n): fbox(fr,0,length,0,0.07,GH+(f-1)*FH-0.1,GH+(f-1)*FH+0.1,"stone_lt",top=True)
            fbox(fr,0,length,0,0.1,GH-0.12,GH+0.12,"stone_lt")
            if side!=bd["face"]: continue
            for q in range(int(H/1.4)):
                z0=q*1.4+0.1; w=0.5 if q%2==0 else 0.34
                fbox(fr,0,w,-0.01,0.06,z0,z0+0.66,"stone_lt",top=False); fbox(fr,length-w,length,-0.01,0.06,z0,z0+0.66,"stone_lt",top=False)
    with grp(UG):
        e=0.28; cr=(r[0]-e,r[1]-e,r[2]+e,r[3]+e)
        for side in ("S","E","N","W"):
            fr,length=frame_for(cr,side,Z)
            pquad("palette",fr.p(0,0,H-0.55),fr.p(length,0,H-0.55),fr.p(length,0,H),fr.p(0,0,H),"stone_lt",fr.o(0,1))
            pquad("palette",fr.p(0,0,H-0.55),fr.p(length,0,H-0.55),fr.p(length,-e,H-0.55),fr.p(0,-e,H-0.55),"stone",(0,0,-1))
        top=Z+H
        rtv=((idx*2654435761)&0xFFFFFFFF)%5; rtb="roof_tile" if rtv==0 else f"roof_tile_v{rtv}"   # this building's barrel-tile tint variant (pure function of idx — consumes no RNG, so dormers/chimneys/props roll exactly as before)
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
                mb(rtb).quad(E0,E1,T1,T0,(u(E0),0),(u(E1),0),(u(T1),sl),(u(T0),sl),out)
            if hx>=hy:
                face_(A,B,R1,R2,"x"); face_(C,D,R2,R1,"x"); mb(rtb).tri(B,C,R2,(0,0),(1,0),(0.5,sl),(1,0,0.5)); mb(rtb).tri(D,A,R1,(0,0),(1,0),(0.5,sl),(-1,0,0.5))
            else:
                face_(B,C,R1,R2,"y"); face_(D,A,R2,R1,"y"); mb(rtb).tri(A,B,R1,(0,0),(1,0),(0.5,sl),(0,-1,0.5)); mb(rtb).tri(C,D,R2,(0,0),(1,0),(0.5,sl),(0,1,0.5))
            def dormer(px,py,pz,nx,ny):
                """Small gabled dormer standing on the slope at (px,py,pz); (nx,ny) = outward slope direction."""
                w=0.7; tx,ty=-ny,nx; d=1.0; hgt=1.25
                P=lambda a,b_,c:(px+tx*a+nx*b_,py+ty*a+ny*b_,pz+c)
                pquad("palette",P(-w,0,0),P(w,0,0),P(w,0,hgt),P(-w,0,hgt),"stone_lt",(nx,ny,0))
                pquad("palette",P(-w*0.6,0.02,0.2),P(w*0.6,0.02,0.2),P(w*0.6,0.02,hgt-0.15),P(-w*0.6,0.02,hgt-0.15),"ink",(nx,ny,0))
                for s in (-1,1):
                    pquad("palette",P(s*w,0,0),P(s*w,-d,0.45),P(s*w,-d,hgt),P(s*w,0,hgt),"stone_lt",(tx*s,ty*s,0))
                    pquad("palette",P(s*w,0,hgt),P(s*w,-d,hgt),P(0,-d,hgt+0.6),P(0,0,hgt+0.6),"brick",(tx*s*0.5,ty*s*0.5,1)) if False else None
                ptri("palette",P(-w,0,hgt),P(w,0,hgt),P(0,0,hgt+0.6),"stone_lt",(nx,ny,0))
                for s in (-1,1): pquad("palette",P(s*(w+0.1),0.1,hgt-0.05),P(0,0.1,hgt+0.62),P(0,-d,hgt+0.62),P(s*(w+0.1),-d,hgt-0.05),"brick",(tx*s*0.5,ty*s*0.5,1.0) if s>0 else (tx*s*0.5,ty*s*0.5,1.0))
            if market or rnd.random()<0.5:
                nd=int((2*max(hx,hy))/7); f=0.55
                for k in range(nd):
                    u=(k+0.5)/max(nd,1)
                    if hx>=hy:
                        px=x0+0.6+u*(x1-x0-1.2)
                        for sgn,ye in ((-1,y0),(1,y1)): dormer(px,ye-sgn*f*hy*-1 if False else ye+sgn*(-f*hy)*-1*-1 if False else (ye-sgn*f*hy*-1 if False else ye+(f*hy)*(1 if sgn<0 else -1)),top+f*rise,0,sgn)
                    else:
                        py=y0+0.6+u*(y1-y0-1.2)
                        for sgn,xe in ((-1,x0),(1,x1)): dormer(xe+(f*hx)*(1 if sgn<0 else -1),py,top+f*rise,sgn,0)
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
    arc=[0.0]
    for k in range(N): arc.append(arc[-1]+math.hypot(pts[k+1][0]-pts[k][0],pts[k+1][1]-pts[k][1]))   # cumulative vault arc (m): the hall's UVs become true metres/3, the pitched-roof convention, so roof_hall's tile_m 1.5 lands a 5.2 m repeat on the curve
    for k in range(N):
        (ya,za),(yb,zb)=pts[k],pts[k+1]; mid=((ya+yb)/2-(y0+y1)/2,((za+zb)/2-top)); out=(0,mid[0],max(mid[1],0.01)*3)
        mb("roof_hall").quad((x0-0.5,ya,za),(x1+0.5,ya,za),(x1+0.5,yb,zb),(x0-0.5,yb,zb),(x0/3,arc[k]/3),(x1/3,arc[k]/3),(x1/3,arc[k+1]/3),(x0/3,arc[k+1]/3),out)
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
BENCHES=[]                                                                  # plaza benches become CC0 Sketchfab "Low Poly Medieval" benches (placed with the other SK props)
for k in range(8):                                                           # fountain jets + benches around the basin
    a=2*math.pi*k/8+math.pi/8; x=8.0*math.cos(a); y=8.0*math.sin(a); cyl(x,y,Z+0.6,Z+1.5,0.08,6,"stone_lt",r1=0.05); cyl(x,y,Z+1.5,Z+1.55,0.18,6,"water")
    bx=13.0*math.cos(a); by=13.0*math.sin(a); BENCHES.append((bx,by,abs(math.cos(a))<0.7))
def blob(cx,cy,cz,r,nm,seg=8,ring=5):
    def Pt(i,j):
        if j==0: return (cx,cy,cz-r*0.8)
        if j==ring: return (cx,cy,cz+r)
        ph=math.pi*j/ring; th=2*math.pi*(i%seg)/seg; rr=r*(0.93+0.14*((i*7+j*13)%5)/5); return (cx+rr*math.sin(ph)*math.cos(th),cy+rr*math.sin(ph)*math.sin(th),cz+rr*math.cos(ph))
    for j in range(ring):
        for i in range(seg):
            a,b_,c,d=Pt(i,j),Pt(i+1,j),Pt(i+1,j+1),Pt(i,j+1); o=((a[0]+c[0])/2-cx,(a[1]+c[1])/2-cy,(a[2]+c[2])/2-cz)
            if j==0: ptri("palette",a,c,d,nm,o)
            elif j==ring-1: ptri("palette",a,b_,c,nm,o)
            else: pquad("palette",a,b_,c,d,nm,o)
# ---------------- stalls ----------------
ROW={"teal":0,"saffron":1,"crimson":2,"cream":3}
GOODS=["crimson","gold","leaf","cream","water_deep","trunk_dark","orange","yellow","lime","magenta"]
SIDE_SACKS=[]
MEDSTALLS={i for i,_ in enumerate(P["stalls"]) if random.Random(4000+i).random()<0.35}   # ~1/3 of stalls are the CC0 Sketchfab village stall
for si_,s in enumerate(P["stalls"]):
    if si_ in MEDSTALLS: continue
    cx,cy=s["c"]; w,d=s["size"]; hx,hy=w/2,d/2; z=Z; sg=1 if s["facing"]=="S" else -1
    pbox(cx-hx+0.25,cy-hy+0.2,cx+hx-0.25,cy+hy-0.2,z,z+0.95,"wood"); pbox(cx-hx+0.2,cy-hy+0.15,cx+hx-0.2,cy+hy-0.15,z+0.95,z+1.0,"wood_dark")
    for px_ in (-hx,hx):
        for py_ in (-hy,hy): pbox(cx+px_-0.06,cy+py_-0.06,cx+px_+0.06,cy+py_+0.06,z,z+2.7,"trunk")
    row=ROW[s["canopy"]]; v0=row/4+0.02; v1=(row+1)/4-0.02; hi=z+2.85; lo=z+2.35; yb=cy+sg*(hy+0.4); yf=cy-sg*(hy+0.4)
    for sgn in (1,-1): mb("awning").quad((cx-hx-0.3,yb,hi),(cx+hx+0.3,yb,hi),(cx+hx+0.3,yf,lo),(cx-hx-0.3,yf,lo),(0,v1),(w/2.2,v1),(w/2.2,v0),(0,v0),(0,sgn*sg*-0.45,sgn*0.9))
    for gi in range(5): rng.uniform(0.18,0.34); rng.choice(GOODS)               # the old tinted cuboids: draws kept so the city rng stream is unchanged; real goods are placed by goods.py below
    if rng.random()<0.5: barrel(cx+sg*0+hx+0.7,cy,z)
    for q in range(rng.choice([0,1,2])):                                       # sacks + crate stack beside the stall
        sx=cx+hx+0.9+q*0.8; pbox(sx-0.3,cy-0.9,sx+0.3,cy-0.3,z,z+0.35,"wood"); pbox(sx-0.25,cy-0.85,sx+0.25,cy-0.35,z+0.35,z+0.7,"wood_dark"); rng.choice(["cream","orange","crimson"]); SIDE_SACKS.append((sx,cy+0.6))   # blob sack -> real sack (goods.py section)
    rng.random()                                                                # the floating red price panel is gone (it hid the goods at eye height); draw kept
    for gi in range(3): rng.choice(["orange","lime","crimson","yellow"])
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
# Trees: the faceted palette blobs are replaced by the Sketchfab "Low Poly
# Forest Tree Pack" (99.Miles, CC-BY 4.0 — assets_kit.tree_variants_sketchfab,
# ASSETS.md), loaded with its own atlas textures: study frames showed a flat
# palette re-skin collapses the pack's branch cards into slabs, while the
# textured original reads as a proper low-poly tree. Placed as linked
# duplicates at the plan positions. A dedicated Random keeps the city rng's
# downstream draws identical to the blob build everywhere else (state
# snapshot/restore around the tree loops).
_trng=random.Random(20240); _treecoll=None
def _tree_variants():
    global _treecoll
    if _treecoll is not None: return _treecoll
    assets_kit.tree_variants_sketchfab([
        ("packtree_a","hero_full",None),     # full pine, the workhorse
        ("packtree_b","hero_tall",None),     # tall pine
        ("packtree_c","hero_birch",None),    # autumn birch accent, sparse (the old blob build's orange slot)
    ])
    _treecoll=bpy.data.collections.new("Trees"); bpy.context.scene.collection.children.link(_treecoll)
    return _treecoll
def tree(x,y):
    coll=_tree_variants()
    key=_trng.choices(["packtree_a","packtree_b","packtree_c"],weights=[55,35,10])[0]
    src=assets_kit.LIB[key]; h=_trng.uniform(5.0,7.0); s=h/max(src["dims"][2],1e-3)
    assets_kit.instantiate(key,coll,x,y,Z,_trng.uniform(0,6.28),s,name=f"Tree_{key}")
_rng_state=rng.getstate()
for (x,y) in P["trees"]: tree(x,y)
for t_ in range(-52,53,13):                                                  # plaza rim: trees in planters + benches facing the square
    for (x,y,al) in ((t_,-57.0,True),(t_,57.0,True),(-57.0,t_,False),(57.0,t_,False)):
        if abs(t_)<8: continue
        pbox(x-0.9,y-0.9,x+0.9,y+0.9,Z,Z+0.5,"stone_lt"); pbox(x-0.8,y-0.8,x+0.8,y+0.8,Z+0.5,Z+0.52,"trunk_dark"); tree(x,y)
        BENCHES.append((x+(3.2 if not al else 0),y+(3.2 if al and y<0 else (-3.2 if al else 0)),al))
rng.setstate(_rng_state)    # tree placement drew only from _trng; keep every later rng draw identical to the blob build
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
for k in range(3):                                                           # party corner festoon (cups placed later)
    string_lights((-7.6,27+k*9.0,Z+5.0),(7.6,27+k*9.0,Z+5.0),sag=0.6)
for k in (-1,1):
    for y_ in (27,36,45): cyl(k*7.6,y_,Z,Z+5.1,0.07,6,"iron",top=False)
# ---------------- hero door statics (instanced) ----------------
LF=Frame((0.0,0.0),(1.0,0.0),(0.0,-1.0),0.0)
for _st in sorted({i[0] for i in doors.INST}):
    with grp(f"DI_{_st}"): doors.door_static(_st,LF)
# ---------------- realise ----------------
NAME={"sidewalk":"Sidewalks","cobble":"PlazaCobble","grass":"Parks","courtyard":"Courtyards","road_avenue":"RoadAvenue","road_narrow":"RoadStreet","road_plain":"RoadJunction","roof_tile":"RoofTile","roof_tile_v1":"RoofTileV1","roof_tile_v2":"RoofTileV2","roof_tile_v3":"RoofTileV3","roof_tile_v4":"RoofTileV4","roof_hall":"RoofHall","roof_flat":"RoofFlat","awning":"Awnings","palette":"Props","water":"Water","lamp_glow":"LampGlow","shutters":"Shutters","signs":"Signs","blades":"BladeSigns","interior_wall":"InteriorWalls","wood_floor":"WoodFloor","rug":"Rug","glass":"Glass","newsprint":"Newsprint"}
LIBG={}
for key,b in MBS.items():
    g,_,m=key.rpartition("::")
    if g.startswith("LIB_") or g.startswith("DI_"): LIBG.setdefault(g,{})[m]=b; continue
    me=bpy.data.meshes.new(key); me.from_pydata(b.v,[],b.f); me.update()
    uvl=me.uv_layers.new(name="UVMap"); uvl.data.foreach_set("uv",[c for tri in b.uv for uv in tri for c in uv])
    nm=NAME.get(m,"B_"+m.replace("facade_","Facade_")); nm=f"{g}_{nm}" if g else nm
    ob=bpy.data.objects.new(nm,me); bpy.context.scene.collection.objects.link(ob); ob.data.materials.append(MATS[m])
for g,parts in LIBG.items():                    # procedural library pieces: one object, one material slot per material
    verts=[]; faces=[]; uvs=[]; midx=[]; mats=list(parts)
    for mi,m in enumerate(mats):
        b=parts[m]; off=len(verts); verts+=b.v; faces+=[tuple(i+off for i in f) for f in b.f]; uvs+=[c for tri in b.uv for uv in tri for c in uv]; midx+=[mi]*len(b.f)
    me=bpy.data.meshes.new(g); me.from_pydata(verts,[],faces); me.update()
    me.uv_layers.new(name="UVMap").data.foreach_set("uv",uvs)
    for m in mats: me.materials.append(MATS[m])
    me.polygons.foreach_set("material_index",midx)
    ob=bpy.data.objects.new(g,me); bpy.context.scene.collection.objects.link(ob)
    if g.startswith("DI_"):                                                    # hero door static part: linked duplicates under one Empty -> EXT_mesh_gpu_instancing
        st=int(g[3:]); root=bpy.data.objects.new(f"inst_door_{doors.STYLE_NAMES[st].split('+')[0]}",None); bpy.context.scene.collection.objects.link(root)
        for i,(s_,x_,y_,z_,r_) in enumerate(i_ for i_ in doors.INST if i_[0]==st):
            o=ob.copy(); o.data=ob.data; o.name=f"door{st}_{i}"; o.location=(x_,y_,z_); o.rotation_euler=(0,0,r_)
            bpy.context.scene.collection.objects.link(o); o.parent=root
        bpy.data.objects.remove(ob,do_unlink=True)
# ---------------- Sketchfab CC0 props baked into the city (linked duplicates: one mesh, many nodes) ----------------
def _sk(name,h):
    L=assets_kit.load(name,600,source="sketchfab",name=f"sk_{name}",tex=256); return L["obj"],h/max(L["dims"][2],1e-3)
_skc=bpy.data.collections.new("SkProps"); bpy.context.scene.collection.children.link(_skc)
_rs=random.Random(909)
for o_ in list(bpy.data.objects):
    pass
SK={n:_sk(n,h) for n,h in (("lantern",0.42),("pot",0.5),("producecrate",0.3),("med_bench",0.96),("med_crate",0.5),("med_stall",2.3))}
SKP=[]                                                                      # (asset, x, y, z, rot) of every placed Sketchfab prop (collision.py)
def _skput(n,x,y,z,rot=0.0):
    SKP.append((n,x,y,z,rot)); src,s=SK[n]; o=src.copy(); o.data=src.data; o.name=f"SK_{n}"; o.location=(x,y,z); o.rotation_euler=(0,0,rot); o.scale=(s,s,s); _skc.objects.link(o)
for si_,s_ in enumerate(P["stalls"]):
    cx,cy=s_["c"]; w_,d_=s_["size"]; hx_,hy_=w_/2,d_/2
    if si_ in MEDSTALLS:                                                      # model front (scalloped awning edge) is -y; facing S keeps it, N turns it round
        src,_s=SK["med_stall"]; o=src.copy(); o.data=src.data; o.name="SK_med_stall"; o.location=(cx,cy,Z); o.rotation_euler=(0,0,0.0 if s_["facing"]=="S" else math.pi); o.scale=(1.4,1.4,1.2); _skc.objects.link(o)
        hx_,hy_=1.55,0.9
    _rs.uniform(-0.6,0.6); _rs.uniform(-0.15,0.15); _rs.uniform(0,6.28)          # the old produce crate (tinted cuboids): draws kept, goods come from goods.py
    for sgn in (-1,1): _skput("lantern",cx+sgn*(hx_-0.1),cy+(hy_+0.35)*(1 if s_["facing"]=="S" else -1),Z+2.2)
    if _rs.random()<0.7: _skput("pot",cx-hx_-0.6,cy+_rs.uniform(-0.8,0.8),Z,_rs.uniform(0,6.28))
for (bx_,by_,hz_) in BENCHES: _skput("med_bench",bx_,by_,Z,0.0 if hz_ else -math.pi/2)     # backrest on +y (horizontal) / +x, as the procedural bench had it
for s_ in P["stalls"]:
    cx,cy=s_["c"]; w_,d_=s_["size"]
    if _rs.random()<0.6: _skput("med_crate",cx+(w_/2+0.45)*_rs.choice([-1,1]),cy+_rs.uniform(-0.5,0.5),Z,_rs.uniform(0,6.28))
# ---------------- stall goods (goods.py / goods_stock.py): every stall sells something; own Random streams, linked duplicates under inst_goods_* Empties ----------------
import goods, goods_stock
_gc=bpy.data.collections.new("StallGoods"); bpy.context.scene.collection.children.link(_gc)
GP=goods.make_objects(bpy,MATS["palette"],assets_kit._lib_collection())
GR={k:(assets_kit.load(d,b,source=src,name=f"goods_{d}",tex=tx)["obj"],sc) for k,(d,src,b,tx,sc,wd) in goods.REAL.items()}
GROOT={}
def _gput(key,x,y,z,rot,sc=1.0):
    src,k0=(GP[key][0],1.0) if key in GP else GR[key]
    if key not in GROOT: GROOT[key]=bpy.data.objects.new(f"inst_goods_{key}",None); bpy.context.scene.collection.objects.link(GROOT[key])
    o=src.copy(); o.data=src.data; o.name=f"G_{key}"; o.location=(x,y,z); o.rotation_euler=(0,0,rot); o.scale=(k0*sc,)*3; o.parent=GROOT[key]; _gc.objects.link(o)
    GCOUNT[key]=GCOUNT.get(key,0)+1
GCOUNT={}; GTRI=0
for si_,s_ in enumerate(P["stalls"]):
    cx,cy=s_["c"]; med=si_ in MEDSTALLS; r0=0.0 if s_["facing"]=="S" else math.pi; c0,s0=math.cos(r0),math.sin(r0); zc=Z+(1.164 if med else 1.0)
    for (key,u,d,rot,sc,dz,hang) in goods_stock.layout(si_,med):
        lx,ly=u,-d; wx=cx+lx*c0-ly*s0; wy=cy+lx*s0+ly*c0
        if hang:
            h=GP[key][1] if key in GP else 0.0
            if key=="r_basket": h=0.37
            if key=="r_lantern": h=0.29
            _gput(key,wx,wy,Z+2.375-(0.0 if key in GP else h),r0+rot,sc)
        else: _gput(key,wx,wy,zc+dz,r0+rot+(math.pi if False else 0.0),sc)
_gr=random.Random(5300)
for (sx_,sy_) in SIDE_SACKS: _gput(_gr.choice(["r_grainsack","r_sack"]),sx_,sy_,Z,_gr.uniform(0,6.28),_gr.uniform(1.0,1.25))
def _gt(k): return GP[k][2] if k in GP else next(v["tris"] for v in assets_kit.LIB.values() if v["obj"] is GR[k][0])
print("GOODS stocks",{k:sum(1 for i in range(len(P["stalls"])) if goods_stock.stock_of(i)==k) for k in goods_stock.STOCK_W},"instances",sum(GCOUNT.values()),"meshes",len(GCOUNT),"tris",sum(GCOUNT[k]*_gt(k) for k in GCOUNT))
print("GOODS top",sorted(((GCOUNT[k]*_gt(k),k,GCOUNT[k],_gt(k)) for k in GCOUNT),reverse=True)[:22])
# ---------------- party corner: user-supplied party cups + beer-pong tables (USDZ), GPU-instanced under one Empty ----------------
_pe=bpy.data.objects.new("PartyCups",None); bpy.context.scene.collection.objects.link(_pe)
def _pc(n,b=320): return assets_kit.load(f"partycups/{n}",b,source="usdz",name=f"pc_{n}",tex=128)
_PT=assets_kit.load("partycups/partyTable",900,source="usdz",name="pc_table",tex=256); _TH=_PT["dims"][2]
_CR=0.072                                                                    # cup rim radius (0.141 m across)
def _put(key,x,y,z,rot=0.0,tilt=None):
    src=assets_kit.LIB[key]["obj"]; o=src.copy(); o.data=src.data; o.name=f"PC_{key}"; o.location=(x,y,z)
    o.rotation_euler=(tilt or 0.0,0,rot); o.parent=_pe; _skc.objects.link(o); return o
_pr=random.Random(4242); COLS=["Red","Blue","Green","Yellow","Pink"]
def pong_table(cx,cy,rot,c1,c2):
    _put("pc_table",cx,cy,Z,rot); ca,sa=math.cos(rot),math.sin(rot); L=_PT["dims"][1]/2-0.12
    for end,col in ((1,c1),(-1,c2)):
        k=_pc(f"partyCup{col}_full",380)
        for row in range(4):                                                 # 4-3-2-1 rack, apex toward the centre line
            for j in range(4-row):
                lx=(j-(3-row)/2)*_CR*2.02; ly=end*(L-row*_CR*1.75)
                if _pr.random()<0.18 and row<2: continue                     # a few cups already sunk
                _put(f"pc_partyCup{col}_full",cx+lx*ca-ly*sa,cy+lx*sa+ly*ca,Z+_TH,rot+_pr.uniform(0,6.28))
    for sx in (-1,1):                                                        # spare stacks on the near corners
        col=_pr.choice(COLS); n=_pr.choice(["stack","shortStack"]); _pc(f"partyCup{col}_{n}")
        lx=sx*(_PT["dims"][0]/2-0.12); _put(f"pc_partyCup{col}_{n}",cx+lx*ca,cy+lx*sa,Z+_TH,_pr.uniform(0,6.28))
def litter(x,y,n):
    for _ in range(n):
        col=_pr.choice(COLS); _pc(f"partyCup{col}_used",240)
        a=_pr.uniform(0,6.28); d=_pr.uniform(0.3,2.5); up=_pr.random()<0.5
        _put(f"pc_partyCup{col}_used",x+d*math.cos(a),y+d*math.sin(a),Z+(0.0 if up else _CR*0.95),_pr.uniform(0,6.28),None if up else math.pi/2)
PARTY=[(-4.2,31.0,0.0,"Red","Blue"),(4.2,31.0,0.0,"Pink","Green"),(0.0,40.5,math.pi/2,"Yellow","Red")]
for t in PARTY:
    pong_table(*t); litter(t[0],t[1],3); ca,sa=math.cos(t[2]),math.sin(t[2])
    _skput("med_crate",t[0]+1.1*ca,t[1]+1.1*sa,Z,_pr.uniform(0,6.28))                       # the cooler
    _skput("med_bench",t[0]-2.0*ca,t[1]-2.0*sa,Z,t[2]+math.pi/2)                             # spectators' bench along the long side
print("PROF",{k:v for k,v in sorted(kit.PROF.items(),key=lambda kv:-kv[1])})
print("MESHES",len(MBS),"TRIS",sum(len(b.f) for b in MBS.values()))
print({k:len(b.f) for k,b in sorted(MBS.items(),key=lambda kv:-len(kv[1].f))[:8]})
os.makedirs(f"{HERE}/out",exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/city3.blend")
for o in bpy.data.objects: o.select_set(not o.name.startswith("LIB_"))     # the shared library ships in its own GLB
# Blender 5.2's meshopt path hard-codes the POSITION exponential filter to 12 bits with ONE
# exponent shared by x, y and z (io_scene_gltf2/io/exp/meshopt.py). At x = -37 m that leaves
# ~6 cm of height precision: a rug 4 cm above a floor snapped onto it. Separate exponents and
# 20 bits keep sub-millimetre precision; the decoder reads any mode (exponents are per component).
import io_scene_gltf2.io.exp.meshopt as _meshopt
_meshopt.EXP_FILTER_BITS=20; _meshopt.ENCODE_EXP_SHARED_VECTOR=_meshopt.ENCODE_EXP_SEPARATE
bpy.ops.export_scene.gltf(filepath=f"{HERE}/out/world-city3.glb",export_format="GLB",export_yup=True,export_apply=True,export_image_format="AUTO",export_texcoords=True,export_normals=True,export_cameras=False,export_lights=False,export_draco_mesh_compression_enable=False,export_meshopt_compression_enable=True,export_gpu_instances=True,use_selection=True)
print("EXPORTED",os.path.getsize(f"{HERE}/out/world-city3.glb")//1024,"KB")
# ---------------- shared library (CC0 imports + procedural pieces) + per-building layouts ----------------
BUDGET={"wooden_bookshelf_worn":3000,"book_encyclopedia_set_01":4000,"desk_lamp_arm_01":2000,"vintage_grandfather_clock_01":3000,"drawer_cabinet":2500,
        "vintage_radio_transceiver":2000,"WoodenTable_02":1514,"ArmChair_01":2500,"potted_plant_02":3000,"wooden_crate_01":1500,
        "vintage_oil_lamp":1500,"wall_clock":1000,"binder_notebook":600,"ChairCushioned":4000}
TEXPX={"wooden_bookshelf_worn":512,"drawer_cabinet":512,"vintage_grandfather_clock_01":512,"ArmChair_01":512,"potted_plant_02":512,"wooden_crate_01":256,
       "book_encyclopedia_set_01":256,"desk_lamp_arm_01":256,"vintage_radio_transceiver":256,"WoodenTable_02":256,"vintage_oil_lamp":128,"wall_clock":256,"binder_notebook":256}
QUAT={"ChairCushioned"}
USED={p[1] for p in kit.PLACEMENTS}
for key in sorted(USED-set(press.PIECE_NAMES)-set(rooms.PIECES)-set(rooms.BOTTLE_KEYS)):
    assets_kit.load(key,BUDGET.get(key,2000),source="quaternius" if key in QUAT else "polyhaven",tex=TEXPX.get(key,256))
bpy.context.view_layer.layer_collection.children["AssetLibrary"].exclude=False
for o in list(bpy.data.objects):
    if o.name.startswith("LIB_") and o.name[4:] not in USED: bpy.data.objects.remove(o,do_unlink=True)      # pieces no room placed
for o in bpy.data.objects: o.select_set(o.name.startswith("LIB_"))
bpy.ops.export_scene.gltf(filepath=f"{HERE}/out/world-city3-library.glb",export_format="GLB",export_yup=True,export_apply=True,export_image_format="JPEG",export_jpeg_quality=80,
    export_texcoords=True,export_normals=True,export_cameras=False,export_lights=False,export_meshopt_compression_enable=True,use_selection=True)
lib_objs=[o for o in bpy.data.objects if o.name.startswith("LIB_")]
print("LIBRARY_EXPORTED",os.path.getsize(f"{HERE}/out/world-city3-library.glb")//1024,"KB",len(lib_objs),"assets",
      {o.name[4:]:sum(len(p.vertices)-2 for p in o.data.polygons) for o in lib_objs})
import shutil
shutil.rmtree(f"{HERE}/out/interiors",ignore_errors=True); os.makedirs(f"{HERE}/out/interiors",exist_ok=True)
by_bid={}
for p in kit.PLACEMENTS: by_bid.setdefault(p[0],[]).append(p)
for bid,ps in by_bid.items():
    props=[[p[1],round(p[2],3),round(p[4],3),round(-p[3],3),round(p[5],4),p[6]] for p in ps]          # [asset, x, y, z, rotY, scale] in three.js space
    json.dump({"id":bid,"library":"world-city3-library.glb","props":props},open(f"{HERE}/out/interiors/{bid}.json","w"),separators=(",",":"))
sz=[os.path.getsize(f"{HERE}/out/interiors/{k}.json") for k in by_bid]
print("LAYOUTS",len(by_bid),"files; props min/avg/max",min(len(v) for v in by_bid.values()),sum(len(v) for v in by_bid.values())//len(by_bid),max(len(v) for v in by_bid.values()),"| bytes total",sum(sz))
CREDITS=[{"asset":k,"source":v.get("credit") or ("https://opengameart.org/content/furniture-low-poly" if v["source"]=="quaternius" else (json.load(open(f"{HERE}/assets/sketchfab/{v['id']}/meta.json"))["source"] if v["source"]=="sketchfab" else f"https://polyhaven.com/a/{v['id']}")),"license":v.get("credit_license","CC0")} for k,v in assets_kit.LIB.items() if v["source"] not in ("usdz","blendswap")]
CREDITS+=[{"asset":k,"source":"https://blendswap.com/blend/33793","license":"CC0 (uploader-declared), coldpengu"} for k,v in assets_kit.LIB.items() if v["source"]=="blendswap"]
CREDITS+=[{"asset":k,"source":"user-supplied upload (partycups_usdz.zip)","license":"not stated"} for k,v in assets_kit.LIB.items() if v["source"]=="usdz"]
json.dump(CREDITS,open(f"{HERE}/out/asset-credits.json","w"),indent=1)
GROUND_TOP=Z+GH+0.05
rooms_idx=[]
for hid,hi in HERO_INFO.items():
    fr=hi["fr"]; bd=hi["bd"]; r=bd["rect"]; dx,dy=fr.xy(hi["door_u"],0.0); sp=hi["spec"]
    e=0.7; ins=0.12; x0,y0,x1,y1=r                                                    # past the eaves on the street/back sides; INSET on the party-wall sides:
    if bd["face"] in ("S","N"): cut=[x0+ins,-(y1+e),x1-ins,-(y0-e)]                    # a clip plane lying exactly on a neighbour's wall would dither it
    else: cut=[x0-e,-(y1-ins),x1+e,-(y0+ins)]
    rooms_idx.append({"id":hid,"lot":sp["lot"],"name":sp["name"],"template":sp["template"],"front":bd["face"],"center":[round((r[0]+r[2])/2,2),round(-(r[1]+r[3])/2,2)],
        "door":[round(dx,2),round(-dy,2)],"rect":[r[0],-r[3],r[2],-r[1]],"cut":{"rect":[round(v,2) for v in cut],"y":round(GROUND_TOP,2)},
        "layout":f"/assets/interiors/{hid}.json","featured":hid in ("tea","press")})
json.dump(rooms_idx,open(f"{HERE}/out/interiors/index.json","w"),separators=(",",":"))
json.dump(rooms_idx,open(f"{HERE}/out/heroes.json","w"),indent=1)
json.dump({"units":"m, three.js XZ; heading = atan2(fx, fz)","anchors":kit.ANCHORS},open(f"{HERE}/out/hero-anchors.json","w"),indent=1)
print("ANCHORS",len(kit.ANCHORS),{h:sum(1 for a in kit.ANCHORS if a["building"]==h) for h in HERO_INFO})

# ---------------- collision (collision.py / col_interiors.py): closed solids + hero rooms, and furniture boxes per room ----------------
import collision, col_interiors
def _skdim(n):
    d=assets_kit.LIB[f"sk_{n}"]["dims"]; k=SK[n][1]; return (d[0]*k,d[1]*k,d[2]*k)
collision.bazaar(dict(P=P,GH=GH,FH=FH,HERO_INFO=HERO_INFO,SKP=SKP,SKDIM={n:_skdim(n) for n in ("med_bench","med_crate","pot")},PARTY=PARTY,PT_DIMS=_PT["dims"],MEDSTALLS=MEDSTALLS),f"{HERE}/out/world-city3-collision.glb")
col_interiors.write(HERO_INFO,f"{HERE}/out/interiors")
