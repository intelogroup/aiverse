"""Bazaar stall goods: procedural produce / cloth / pottery / bottles / bread pieces on the shared palette, plus the stall "stocks"
that decide what each of the 80 stalls sells (dedicated Random streams: no draw from the city rng, so later seeded layouts do not shift).

Pieces are built here as plain vertex/face lists (origin = bottom centre, z up, front = -y) and turned into Blender meshes by `build_pieces`.
Real CC0 assets (Sketchfab Avramania "Low Poly Medieval": Basket, Grain Sack, Sack, Roll, Cheese Wheel, Pot, Lantern) are placed by build_city.py
alongside; `REAL` lists them with the scale each gets. Every piece is placed as a linked duplicate under an `inst_goods_*` Empty."""
import math, random

# ---------------------------------------------------------------- geometry accumulator
class G:
    def __init__(s): s.v=[]; s.f=[]; s.c=[]; s.sm=[]
    def add(s,verts,faces,col,smooth=False):
        o=len(s.v); s.v+=verts
        for f in faces:
            s.f.append(tuple(i+o for i in f)); s.c.append(col); s.sm.append(smooth)
    def addc(s,verts,faces,cols,smooth=False):            # per-face colours
        o=len(s.v); s.v+=verts
        for f,c in zip(faces,cols): s.f.append(tuple(i+o for i in f)); s.c.append(c); s.sm.append(smooth)
    def tris(s): return len(s.f)
    def height(s): return max(v[2] for v in s.v) if s.v else 0.0

_ICO=None
def _ico():
    global _ICO
    if _ICO: return _ICO
    t=(1+5**0.5)/2
    v=[(-1,t,0),(1,t,0),(-1,-t,0),(1,-t,0),(0,-1,t),(0,1,t),(0,-1,-t),(0,1,-t),(t,0,-1),(t,0,1),(-t,0,-1),(-t,0,1)]
    v=[tuple(c/math.sqrt(1+t*t) for c in p) for p in v]
    f=[(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),(3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]
    _ICO=(v,f); return _ICO

def ico(g,cx,cy,cz,rx,ry,rz,col,rot=0.0,smooth=True):
    v,f=_ico(); ca,sa=math.cos(rot),math.sin(rot)
    vv=[(cx+(p[0]*ca-p[1]*sa)*rx,cy+(p[0]*sa+p[1]*ca)*ry,cz+p[2]*rz) for p in v]
    g.add(vv,f,col,smooth)

def box(g,x0,y0,z0,x1,y1,z1,col):
    v=[(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    f=[(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
    g.add(v,f,col,False)

def _basis(a):
    ax,ay,az=a; n=math.sqrt(ax*ax+ay*ay+az*az); a=(ax/n,ay/n,az/n)
    h=(0,0,1) if abs(a[2])<0.9 else (1,0,0)
    u=(a[1]*h[2]-a[2]*h[1],a[2]*h[0]-a[0]*h[2],a[0]*h[1]-a[1]*h[0]); m=math.sqrt(sum(c*c for c in u)); u=tuple(c/m for c in u)
    w=(a[1]*u[2]-a[2]*u[1],a[2]*u[0]-a[0]*u[2],a[0]*u[1]-a[1]*u[0]); return u,w,a

def lathe(g,p0,axis,prof,seg,cols,smooth=True,cap0=True,cap1=False,squash=1.0,spin=0.0):
    """Surface of revolution about `axis` from point p0. prof=[(radius,height along axis)], bottom to top; cols = one colour or one per band.
    cap0 closes the first ring with a fan (a closed bottom), cap1 the last ring."""
    u,w,a=_basis(axis); n=len(prof); verts=[]; faces=[]; fc=[]
    for (r,h) in prof:
        for k in range(seg):
            t=spin+2*math.pi*k/seg; c,s=math.cos(t)*r,math.sin(t)*r*squash
            verts.append((p0[0]+u[0]*c+w[0]*s+a[0]*h,p0[1]+u[1]*c+w[1]*s+a[1]*h,p0[2]+u[2]*c+w[2]*s+a[2]*h))
    for j in range(n-1):
        col=cols[j] if isinstance(cols,(list,tuple)) else cols
        for k in range(seg):
            k2=(k+1)%seg; a0=j*seg+k; b0=j*seg+k2; c0=(j+1)*seg+k2; d0=(j+1)*seg+k
            if prof[j][0]<1e-6: faces.append((a0,c0,d0)); fc.append(col)           # degenerate bottom ring: one tri
            elif prof[j+1][0]<1e-6: faces.append((a0,b0,c0)); fc.append(col)
            else: faces+=[(a0,b0,c0),(a0,c0,d0)]; fc+=[col,col]
    g.addc(verts,faces,fc,smooth)
    for cap,j,flip in ((cap0,0,True),(cap1,n-1,False)):
        if cap and prof[j][0]>1e-6:
            col=(cols[0] if flip else cols[-1]) if isinstance(cols,(list,tuple)) else cols
            ctr=(p0[0]+a[0]*prof[j][1],p0[1]+a[1]*prof[j][1],p0[2]+a[2]*prof[j][1]); vs=[ctr]+verts[j*seg:(j+1)*seg]
            fs=[(0,1+(k+1)%seg,1+k) if flip else (0,1+k,1+(k+1)%seg) for k in range(seg)]
            g.add(vs,fs,col,False)

def bar(g,p,q,r,seg,col,cap=True,r1=None):
    d=(q[0]-p[0],q[1]-p[1],q[2]-p[2]); L=math.sqrt(sum(c*c for c in d)); lathe(g,p,d,[(r,0),(r if r1 is None else r1,L)],seg,col,smooth=True,cap0=cap,cap1=cap)

# ---------------------------------------------------------------- shared building blocks
FRUIT={"apple_r":("crimson",0.045),"apple_g":("lime",0.045),"orange":("orange",0.048),"lemon":("yellow",0.04),"plum":("purple",0.034),"tomato":("crimson",0.042),
       "cabbage":("leaf",0.085),"cabbage2":("lime",0.08),"pepper_y":("yellow",0.04),"pepper_r":("magenta",0.04),"pear":("lime",0.042),"peach":("pink",0.045),
       "melon":("leaf",0.12),"pumpkin":("orange",0.12),"aubergine":("purple",0.05),"apple_y":("gold",0.045),"lime":("leaf",0.035),"beet":("magenta",0.045)}

def fruit(g,rng,kind,x,y,z):
    col,r=FRUIT[kind]; r*=rng.uniform(0.9,1.1); sq=rng.uniform(0.82,0.95)
    ico(g,x,y,z+r*sq,r,r,r*sq,col,rng.uniform(0,6.28))
    return r

def crate(g,w,d,h,col="wood",inner="wood_dark"):
    t=0.015; box(g,-w/2+t,-d/2+t,0,w/2-t,d/2-t,0.085,inner)
    box(g,-w/2,-d/2,0,-w/2+t,d/2,h,col); box(g,w/2-t,-d/2,0,w/2,d/2,h,col)
    box(g,-w/2+t,-d/2,0,w/2-t,-d/2+t,h,col); box(g,-w/2+t,d/2-t,0,w/2-t,d/2,h,col)
    for s in (-1,1): box(g,s*(w/2-0.03)-0.02,-d/2-0.004,h*0.45,s*(w/2-0.03)+0.02,d/2+0.004,h*0.55,"wood_dark")      # corner battens

def fill_rect(g,rng,w,d,z0,r,kinds,layers=3,dome=0.25):
    """Hex-ish packed fruit in a w x d rectangle, `layers` deep, each layer shrinking toward the middle (a heaped crate)."""
    for L in range(layers):
        ww=w-L*2.1*r*0.9; dd=d-L*2.1*r*0.9
        if ww<r*2 or dd<r*2: break
        nx=max(1,int(ww/(2*r))); ny=max(1,int(dd/(2*r))); z=z0+L*r*1.55
        for i in range(nx):
            for j in range(ny):
                x=(i-(nx-1)/2)*ww/max(nx,1)*(nx/(nx)) ; y=(j-(ny-1)/2)*dd/max(ny,1)
                if (L%2) and nx>1: x+=ww/nx*0.25
                fruit(g,rng,rng.choices(kinds[0],kinds[1])[0],x+rng.uniform(-0.01,0.01),y+rng.uniform(-0.01,0.01),z+dome*r*(1-(abs(x)/(w/2+1e-6))))

def fill_disc(g,rng,R,z0,r,kinds,layers=3):
    for L in range(layers):
        RR=R-L*1.6*r
        if RR<0: break
        z=z0+L*r*1.5
        if L==layers-1 or RR<r*1.2: fruit(g,rng,rng.choices(kinds[0],kinds[1])[0],0,0,z); break
        n=max(3,int(2*math.pi*RR/(2.1*r)))
        for k in range(n):
            a=2*math.pi*k/n+L*0.5; fruit(g,rng,rng.choices(kinds[0],kinds[1])[0],RR*math.cos(a),RR*math.sin(a),z)
        if RR>2.2*r: fill_disc_ring(g,rng,RR-2.0*r,z,r,kinds)
def fill_disc_ring(g,rng,RR,z,r,kinds):
    n=max(3,int(2*math.pi*RR/(2.1*r)))
    for k in range(n):
        a=2*math.pi*k/n; fruit(g,rng,rng.choices(kinds[0],kinds[1])[0],RR*math.cos(a),RR*math.sin(a),z+0.2*r)

# ---------------------------------------------------------------- pieces: crates of produce (0.56 x 0.38) and mounds for the real basket
def P_crate(kinds,layers=3,r=None,veg=False,dome=0.3):
    def f(g,rng):
        crate(g,0.56,0.38,0.14); fill_rect(g,rng,0.50,0.32,0.085,r or 0.045,kinds,layers,dome)
    return f
def P_mound(kinds,layers=3,r=0.04):
    def f(g,rng): fill_disc(g,rng,0.11,0.0,r,kinds,layers)
    return f
def P_pyramid(kind_cols,r=0.05,n=4):
    """Fruit pyramid on a board: n x n base, n-1 ... 1."""
    def f(g,rng):
        box(g,-0.3,-0.3,0,0.3,0.3,0.03,"wood")
        for L in range(n):
            m=n-L
            for i in range(m):
                for j in range(m):
                    fruit(g,rng,rng.choices(kind_cols[0],kind_cols[1])[0],(i-(m-1)/2)*2*r*1.02,(j-(m-1)/2)*2*r*1.02,0.03+L*r*1.5)
    return f
def P_carrots(g,rng):
    crate(g,0.56,0.38,0.14)
    for row in range(6):
        for h in (-1,1):
            y=-0.15+row*0.06+rng.uniform(-0.005,0.005); z=0.105+(0.035 if row%2 else 0.0); L=rng.uniform(0.2,0.24); x0=h*rng.uniform(0.02,0.05)
            bar(g,(x0,y,z),(x0+h*L,y,z+0.01),0.026,5,"orange",cap=False,r1=0.004)
            ico(g,x0-h*0.005,y,z+0.005,0.022,0.028,0.022,"leaf",0)
def P_greens(g,rng):
    crate(g,0.56,0.38,0.14); fill_rect(g,rng,0.50,0.32,0.085,0.085,(["cabbage","cabbage2","cabbage"],[3,2,1]),2,0.2)
def P_melons(g,rng):
    crate(g,0.62,0.44,0.12);
    for i,(x,y,k) in enumerate([(-0.18,-0.08,"melon"),(0.16,-0.1,"pumpkin"),(-0.14,0.12,"pumpkin"),(0.2,0.12,"melon"),(0.0,0.02,"melon")]):
        z=0.085+(0.1 if i==4 else 0.0); fruit(g,rng,k,x,y,z)

# ---------------------------------------------------------------- spice trays (4 bowls of coloured heaps on a board)
def P_spices(cols):
    def f(g,rng):
        box(g,-0.5,-0.15,0,0.5,0.15,0.025,"wood_dark")
        for i,c in enumerate(cols):
            x=-0.375+i*0.25; lathe(g,(x,0,0.025),(0,0,1),[(0.07,0),(0.11,0.045),(0.1,0.07)],8,"terracotta",smooth=True)
            lathe(g,(x,0,0.045),(0,0,1),[(0.1,0),(0.04,0.05+rng.uniform(0,0.02)),(0,0.09+rng.uniform(0,0.03))],8,c,smooth=False)
    return f
# ---------------------------------------------------------------- hanging strings (origin at the top, hang downward = negative z)
def P_hang(kind):
    def f(g,rng):
        n=7 if kind!="herbs" else 4; box(g,-0.004,-0.004,-0.7,0.004,0.004,0.0,"trunk_dark")
        box(g,-0.06,-0.01,-0.012,0.06,0.01,0.012,"wood")
        for i in range(n):
            z=-0.08-i*0.085; s=1 if i%2 else -1
            if kind=="chili":
                c=rng.choice(["crimson","crimson","fire"]); bar(g,(s*0.025,0,z),(s*0.03,0.0,z-0.13),0.016,5,c,cap=False,r1=0.003)
                bar(g,(s*0.025,0.008,z),(s*0.032,0.01,z-0.12),0.014,5,c,cap=False,r1=0.003)
            elif kind=="garlic": ico(g,s*0.03,0,z-0.035,0.04,0.04,0.045,rng.choice(["white","cream","cream"]),rng.uniform(0,6),True)
            elif kind=="onion": ico(g,s*0.032,0,z-0.04,0.05,0.05,0.055,rng.choice(["terracotta","orange","brick"]),rng.uniform(0,6),True)
            elif kind=="pepper":
                for k in (-1,1): ico(g,k*0.035,0,z-0.04,0.03,0.03,0.05,rng.choice(["yellow","orange","crimson","lime"]),0,True)
            elif kind=="herbs":
                bar(g,(0,0,-0.1-i*0.1),(s*0.07,0.0,-0.3-i*0.1),0.03,5,rng.choice(["leaf","leaf_dark","lime"]),cap=False,r1=0.004)
    return f

# ---------------------------------------------------------------- cloth
CLOTH=["cloth_red","cloth_blue","cloth_gold","cloth_green","teal","magenta","purple","pink","orange","crimson","cream","sky_blue","yellow"]
def P_bolts(n_rows=3):
    """A pyramid of horizontal bolts along x (0.55 long), colours distinct."""
    def f(g,rng):
        cs=rng.sample(CLOTH,6); k=0; r=0.065
        for row in range(n_rows):
            m=n_rows-row
            for i in range(m):
                x=(i-(m-1)/2)*2*r*1.0; z=r+row*r*1.75
                bar(g,(-0.28,x,z),(0.28,x,z),r,7,cs[k%6],cap=True); k+=1
    return f
def P_rolls(g,rng):
    """Upright cloth rolls in a tight bunch, a few leaning."""
    cs=rng.sample(CLOTH,6)
    for i,(x,y) in enumerate([(-0.14,-0.08),(0.0,-0.1),(0.14,-0.07),(-0.07,0.05),(0.07,0.06),(0.0,-0.0)]):
        h=rng.uniform(0.5,0.62); bar(g,(x,y,0),(x+rng.uniform(-0.03,0.03),y,h),0.058,7,cs[i],cap=True)
def P_folded(g,rng):
    cs=rng.sample(CLOTH,6)
    for s,(x0) in enumerate((-0.32,0.0,0.32)):
        n=rng.randint(4,6)
        for k in range(n):
            col=cs[(s*2+k)%6]; j=rng.uniform(-0.012,0.012); box(g,x0-0.14+j,-0.1+j,k*0.032,x0+0.14+j,0.1+j,k*0.032+0.03,col)
def P_drape(cols):
    """Hanging cloth, origin at the top rail (z=0), falls to z=-0.95; stripes alternate along x; double sided."""
    def f(g,rng):
        W=0.62; H=0.72; nx=6; nz=3; ph=rng.uniform(0,6)
        def pt(i,j): x=-W/2+W*i/nx; z=-H*j/nz; return (x,0.04*math.sin(ph+i*1.2)*(j/nz)+0.02,z)
        box(g,-W/2-0.03,-0.015,-0.02,W/2+0.03,0.025,0.015,"wood_dark")
        for i in range(nx):
            col=cols[i%len(cols)]
            for j in range(nz):
                a,b,c,d=pt(i,j),pt(i+1,j),pt(i+1,j+1),pt(i,j+1)
                g.add([a,b,c,d],[(0,2,1),(0,3,2),(0,1,2),(0,2,3)],col,False)
    return f

# ---------------------------------------------------------------- pottery
# Phase-2 realism forms live in pottery_spec.py (closed-solid lathe profiles
# with inner wall + rim roll, attached handle arcs). The baked GLBs carry the
# full realism; these tables reproduce the same forms at generator fidelity.
from pottery_spec import PROFILES as SPEC_PROFILES, HANDLES as SPEC_HANDLES, BANDS as SPEC_BANDS, RPOT_GENERATOR_SCALE
POTP={"amphora":SPEC_PROFILES["amphora"],"jug":SPEC_PROFILES["jug"],"vase":SPEC_PROFILES["vase"],
      "bowl":SPEC_PROFILES["potbowl"],"pitcher":SPEC_PROFILES["pitcher"],"urn":SPEC_PROFILES["urn"]}
def _band_cols(prof,kind,glaze):
    """Per-segment palette colours from the spec glaze bands (normalised height)."""
    a,b=GLAZE[glaze]; band=SPEC_BANDS.get(kind,(0.0,1.0))
    if band is None: return [b]*(len(prof)-1)                       # potbowl: uniform band colour, as shipped
    lo,hi=band; H=max(h for _,h in prof) or 1.0
    return [a if lo<=((prof[j][1]+prof[j+1][1])/2)/H<=hi else b for j in range(len(prof)-1)]
def _arc(g,cx,cy,pts,s,r,col):
    """Attached handle: bar segments along the spec arc (endpoints buried in the wall)."""
    P=[(cx+px*s,cy,pz*s) for (px,pz) in pts]
    for p,q in zip(P,P[1:]): bar(g,p,q,r*s,5,col,cap=False)
GLAZE={"terra":("terracotta","brick"),"blue":("door_blue","sky_blue"),"green":("pot_green","leaf"),"cream":("cream","terracotta"),"ochre":("gold","terracotta"),"brick":("brick","terracotta")}
def pot(g,rng,kind,x,y,glaze,s=1.0):
    pr=[(r*s,h*s) for r,h in POTP[kind]]; a,b=GLAZE[glaze]
    lathe(g,(x,y,0),(0,0,1),pr,10,_band_cols(pr,"potbowl" if kind=="bowl" else kind,glaze),smooth=True,cap0=True)
    if kind in SPEC_HANDLES:                                                  # attached handle arc (was a 2-bar corner)
        pts,tr=SPEC_HANDLES[kind]; _arc(g,x,y,pts,s,tr,b)
def P_pots(spec):
    def f(g,rng):
        for (k,x,y,gl,s) in spec: pot(g,rng,k,x,y,gl,s)
    return f
def P_stacks(g,rng):
    for (x,gl) in ((-0.2,rng.choice(list(GLAZE))),(0.18,rng.choice(list(GLAZE)))):
        n=rng.randint(3,4)
        for k in range(n):
            lathe(g,(x,0,k*0.05),(0,0,1),SPEC_PROFILES["bowl"],10,_band_cols(SPEC_PROFILES["bowl"],"bowl",gl),smooth=True)
def P_plates(g,rng):
    for i,(x,y) in enumerate(((-0.2,0.0),(0.2,0.0))):
        gl=rng.choice(list(GLAZE)); a,b=GLAZE[gl]
        for k in range(rng.randint(3,5)): lathe(g,(x,y,k*0.016),(0,0,1),[(0.0,0),(0.09,0.0),(0.14,0.022)],7,[a,b],smooth=False)

# ---------------------------------------------------------------- bottles / oils / wine
BOTTLE=[(0.0,0),(0.037,0),(0.038,0.12),(0.015,0.19),(0.015,0.26),(0.018,0.27)]
BOTTLE2=[(0.0,0),(0.032,0),(0.033,0.1),(0.013,0.16),(0.013,0.2),(0.016,0.21)]
FLASK=[(0.0,0),(0.055,0),(0.06,0.08),(0.016,0.15),(0.016,0.2),(0.02,0.205)]
def P_bottles(cols,tray=True):
    def f(g,rng):
        if tray: box(g,-0.28,-0.2,0,0.28,0.2,0.03,"wood_dark")
        k=0
        for row,(y,n) in enumerate(((-0.1,3),(0.1,3))):
            for i in range(n):
                x=(i-(n-1)/2)*0.12; c=cols[(i+row*2)%len(cols)]; pr=rng.choice([BOTTLE,BOTTLE,BOTTLE2,FLASK])
                lathe(g,(x,y,0.03 if tray else 0),(0,0,1),pr,6,[c]*(len(pr)-3)+["wood","wood"],smooth=True)
    return f
def P_goblets(g,rng):
    for (x,y,s) in ((-0.2,0,1.0),(0.0,0.05,1.2),(0.2,-0.02,1.0)):
        pr=[(r*s,h*s) for r,h in SPEC_PROFILES["goblet"]]
        cols=["brass" if (pr[j][1]+pr[j+1][1])/2<0.09*s else "gold" for j in range(len(pr)-1)]
        lathe(g,(x,y,0),(0,0,1),pr,10,cols,smooth=True)
def P_ewer(g,rng):
    for (x,s,c) in ((-0.2,1.0,"brass"),(0.0,0.8,"copper"),(0.2,1.15,"brass")):
        pr=[(r*s,h*s) for r,h in SPEC_PROFILES["ewer"]]
        lathe(g,(x,0,0),(0,0,1),pr,10,[c]*(len(pr)-1),smooth=True)
        pts,tr=SPEC_HANDLES["ewer"]; _arc(g,x,0,pts,s,tr,c)          # attached ear handle (was a detached floating bar)
def P_rpot(g,rng):
    """Built replacement for the Sketchfab 'pot' import (facet soup): a closed
    lathe storage jar in the same envelope. RPOT_GENERATOR_SCALE bakes in the
    1.1 the REAL entry used to apply through the instance scale."""
    pr=[(r*RPOT_GENERATOR_SCALE,h*RPOT_GENERATOR_SCALE) for r,h in SPEC_PROFILES["rpot"]]
    lathe(g,(0,0,0),(0,0,1),pr,10,["terracotta"]*(len(pr)-1),smooth=True)

# ---------------------------------------------------------------- bread / dairy
def loaf(g,rng,x,y,r=0.13,h=0.1,z0=0.0):
    lathe(g,(x,y,z0),(0,0,1),[(r*0.9,0),(r,h*0.35),(r*0.6,h*0.85),(0.0,h)],7,["bread","brick","brick"],smooth=True,squash=rng.uniform(0.8,1.0))
def P_loaves(g,rng):
    box(g,-0.28,-0.2,0,0.28,0.2,0.02,"wood")
    for (x,y) in ((-0.15,-0.07),(0.1,-0.08),(-0.04,0.1),(0.2,0.1),(-0.22,0.12)): loaf(g,rng,x,y,rng.uniform(0.09,0.12),rng.uniform(0.07,0.1),0.02)
def P_baguettes(g,rng):
    box(g,-0.3,-0.15,0,0.3,0.15,0.02,"wood_dark")
    for k in range(7):
        y=-0.12+k*0.04; z=0.045+(0.03 if k%2 else 0.0); a=rng.uniform(-0.08,0.08)
        bar(g,(-0.27,y,z),(0.27,y+a,z),0.026,6,"bread",cap=True)
def P_rollpile(g,rng):
    for L in range(3):
        n=[6,1,0][L]; R=[0.11,0,0][L]
        for k in range(n):
            a=2*math.pi*k/n; loaf(g,rng,R*math.cos(a),R*math.sin(a),0.055,0.05,L*0.04)
def P_wedges(g,rng):
    for (x,c) in ((-0.22,"yellow"),(0.0,"gold"),(0.22,"cream")):
        for k in range(rng.randint(2,3)):
            ca,sa=math.cos(a:=rng.uniform(-0.5,0.5)),math.sin(a); L=0.15; w=0.1; h=0.05; y0=(k-1)*0.13
            p=[(-L/2,-w/2),(L/2,0),(-L/2,w/2)]; vv=[(x+q[0]*ca-q[1]*sa,y0+q[0]*sa+q[1]*ca,0) for q in p]; vt=[(v[0],v[1],h) for v in vv]
            g.add(vv+vt,[(0,2,1),(3,4,5),(0,1,4),(0,4,3),(1,2,5),(1,5,4),(2,0,3),(2,3,5)],c,False)

# ---------------------------------------------------------------- fruit baskets' fruit mound kinds
def K(*pairs): return ([p[0] for p in pairs],[p[1] for p in pairs])
KINDS={"apples":K(("apple_r",6),("apple_g",2),("apple_y",1)),"greenapples":K(("apple_g",6),("lime",1),("pear",2)),"oranges":K(("orange",8),("lemon",1)),"lemons":K(("lemon",7),("lime",2)),
       "plums":K(("plum",6),("peach",2),("plum",2)),"tomatoes":K(("tomato",7),("orange",1),("pepper_y",1)),"peaches":K(("peach",6),("apple_y",3),("orange",1)),
       "peppers":K(("pepper_y",3),("pepper_r",3),("tomato",2),("lime",2)),"aubergines":K(("aubergine",5),("pepper_r",2),("beet",2)),"pears":K(("pear",6),("apple_y",3),("lime",1)),
       "beets":K(("beet",5),("tomato",2),("orange",1))}

# registry: name -> (builder, seed). Heights come from the built mesh.
REG={}
def reg(name,fn): REG[name]=fn
for nm,kk,ly,rr in (("crate_apples","apples",2,0.052),("crate_greenapples","greenapples",2,0.052),("crate_oranges","oranges",2,0.054),("crate_lemons","lemons",2,0.048),
                    ("crate_plums","plums",2,0.048),("crate_tomatoes","tomatoes",2,0.05),("crate_peppers","peppers",2,0.048),("crate_aubergines","aubergines",2,0.056),
                    ("crate_pears","pears",2,0.052),("crate_beets","beets",2,0.056)):
    reg(nm,P_crate(KINDS[kk],ly,rr))
for nm,kk in (("mound_apples","apples"),("mound_oranges","oranges"),("mound_plums","plums"),("mound_lemons","lemons"),("mound_tomatoes","tomatoes"),("mound_pears","pears")): reg(nm,P_mound(KINDS[kk],2,0.047))
reg("crate_carrots",P_carrots); reg("crate_greens",P_greens); reg("crate_melons",P_melons)
reg("pyr_apples",P_pyramid(KINDS["apples"],0.05,4)); reg("pyr_oranges",P_pyramid(KINDS["oranges"],0.052,4)); reg("pyr_lemons",P_pyramid(KINDS["lemons"],0.05,4))
reg("spice_a",P_spices(["crimson","orange","yellow","leaf"])); reg("spice_b",P_spices(["gold","brick","cream","purple"])); reg("spice_c",P_spices(["orange","leaf","crimson","trunk"]))
reg("spice_d",P_spices(["white","cream","bread","yellow"])); reg("spice_e",P_spices(["bread","gold","cream","brick"]))
for k in ("chili","garlic","onion","pepper","herbs"): reg(f"hang_{k}",P_hang(k))
reg("bolts_a",P_bolts()); reg("bolts_b",P_bolts()); reg("bolts_c",P_bolts(2)); reg("rolls_a",P_rolls); reg("rolls_b",P_rolls); reg("folded_a",P_folded); reg("folded_b",P_folded)
for i,cs in enumerate((["cloth_red","cream"],["cloth_blue","white"],["cloth_gold","crimson"],["teal","cloth_gold"],["magenta","pink"],["cloth_green","cream"])): reg(f"drape_{i}",P_drape(cs))
reg("pots_terra",P_pots([("jug",-0.2,0,"terra",1.0),("amphora",0.0,0.02,"terra",0.85),("vase",0.2,0,"brick",1.0),("pitcher",-0.05,-0.18,"terra",0.9)]))
reg("pots_blue",P_pots([("vase",-0.2,0,"blue",1.0),("jug",0.0,0.0,"blue",1.0),("bowl",0.22,0.02,"blue",1.0),("pitcher",-0.06,-0.19,"cream",0.9)]))
reg("pots_green",P_pots([("amphora",-0.18,0,"green",0.8),("urn",0.05,0.0,"green",0.8),("jug",0.24,0.02,"cream",0.9)]))
reg("pots_mixed",P_pots([("jug",-0.25,0,"ochre",1.0),("vase",-0.02,0.0,"blue",0.95),("urn",0.22,0.02,"terra",0.75),("bowl",-0.1,-0.2,"green",0.9)]))
reg("bowls",P_stacks); reg("plates",P_plates)
reg("bottles_green",P_bottles(["pot_green","leaf_dark","pot_green"])); reg("bottles_amber",P_bottles(["gold","brass","terracotta"])); reg("bottles_blue",P_bottles(["door_blue","sky_blue","teal"]))
reg("bottles_mixed",P_bottles(["pot_green","gold","door_blue","crimson","cream"])); reg("goblets",P_goblets); reg("ewers",P_ewer); reg("r_pot",P_rpot)
reg("loaves",P_loaves); reg("baguettes",P_baguettes); reg("rollpile",P_rollpile); reg("wedges",P_wedges)

def build(name,seed):
    g=G(); REG[name](g,random.Random(seed)); return g

# ---------------------------------------------------------------- Blender side
def make_objects(bpy,pal_mat,coll):
    """Creates one LIB_g_<name> object per piece (excluded from the world export by its LIB_ prefix); returns {name:(obj,height)}."""
    out={}
    for i,name in enumerate(sorted(REG)):
        if name == 'goblets':
            from drinking_glasses import template
            ob = template('bazaar', coll)
            out[name] = (ob, max(v.co.z for v in ob.data.vertices), sum(len(p.vertices)-2 for p in ob.data.polygons))
            continue
        from kit import pal_uv
        g=build(name,5000+i)
        me=bpy.data.meshes.new(f"g_{name}"); me.from_pydata(g.v,[],g.f); me.update()
        uv=[];
        for f,c in zip(g.f,g.c): u=pal_uv(c); uv+=[u[0],u[1]]*len(f)
        me.uv_layers.new(name="UVMap").data.foreach_set("uv",uv)
        me.polygons.foreach_set("use_smooth",g.sm); me.materials.append(pal_mat)
        ob=bpy.data.objects.new(f"LIB_g_{name}",me); coll.objects.link(ob); out[name]=(ob,(g.height() if g.height()>0.05 else -min(v[2] for v in g.v)),g.tris())
    return out

# real CC0 assets used as goods: key -> (asset dir, source, tri budget, tex px, scale, footprint width m)
REAL={"r_basket":("g_basket","sketchfab",170,128,0.62,0.34),"r_grainsack":("g_grainsack","sketchfab",220,128,1.0,0.4),
      "r_sack":("g_sack","sketchfab",240,128,0.85,0.45),"r_roll":("g_roll","sketchfab",190,128,1.5,0.14),"r_cheese":("g_cheese","sketchfab",260,128,1.25,0.4),
      "r_barrel":("g_barrel","sketchfab",220,128,0.6,0.42),"r_lantern":("lantern","sketchfab",130,128,1.0,0.16),
      "r_bucket":("wooden_bucket_01","polyhaven",200,256,0.9,0.38),"r_jug":("metal_jug","polyhaven",200,256,1.5,0.32)}
W={"spice":1.05,"folded":0.95,"bolts":0.62,"rolls":0.42,"pots":0.62,"bowls":0.5,"plates":0.5,"bottles":0.64,"goblets":0.5,"ewers":0.55,"loaves":0.62,"baguettes":0.66,
   "rollpile":0.4,"wedges":0.6,"crate":0.62,"pyr":0.66,"mound":0.4,"r_pot":0.3}   # r_pot keeps its old REAL footprint width now that it is a built piece
