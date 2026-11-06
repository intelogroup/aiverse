"""Entrance doors for the Bazaar's hero shops (geometry only, doors never open).

Five styles. Everything that does not depend on the door colour (frame, glass, handle, kick plate, hood, lamp, steps, plaque) is the
STATIC part: built once per style in a local frame (u along the wall, t out of it, t<0 = into the reveal, z from street level) and placed as linked
duplicates under an Empty `inst_door_sN` (glTF EXT_mesh_gpu_instancing). The LEAF (door_col panels/planks) and the number digits are tiny and
colour/number dependent, so they go in the shared bucketed meshes. Both are built from the same constants so they line up.
Opening (see hero.hero_ground): 1.7 m wide (c +- 0.85), floor f = 0.28 above the street, soffit zt = 2.9, jambs 0.3 deep (t -0.3..0).
"""
import math
from kit import *

F=0.28; ZT=2.9                 # floor height and soffit of the hero door opening
Z0=F+0.03; Z1=2.40             # leaf bottom / top
TF,TB=-0.18,-0.24              # leaf front / back face
TR=-0.15                       # raised panel front
HW=0.72                        # leaf half width
NSTYLES=5
STYLE_NAMES=["panel","glazed+canopy","double","half-glazed+pent","studded"]
INST=[]                        # (style, x, y, z, rot) queued for build_city
FRAME_COL=["cream","iron","cream","wood_dark","iron"]

def rod(fr,a,b,w,color):
    """Thin square-section bar from a=(u,t,z) to b=(u,t,z) lying in a u = const plane's (t,z) section."""
    dt,dz=b[1]-a[1],b[2]-a[2]; L=math.hypot(dt,dz) or 1; nt,nz=-dz/L,dt/L; h=w/2
    C={}
    for s1 in (-1,1):
        for s2 in (-1,1):
            C[(s1,s2)]=(fr.p(a[0]+s1*h,a[1]+s2*h*nt,a[2]+s2*h*nz),fr.p(b[0]+s1*h,b[1]+s2*h*nt,b[2]+s2*h*nz))
    for (k0,k1,o) in (((-1,-1),(1,-1),fr.o(0,-nt,-nz)),((1,-1),(1,1),fr.o(1,0)),((1,1),(-1,1),fr.o(0,nt,nz)),((-1,1),(-1,-1),fr.o(-1,0))):
        pquad("palette",C[k0][0],C[k1][0],C[k1][1],C[k0][1],color,o)

def _glass(fr,u0,u1,z0,z1,t):
    tq("glass",[fr.p(u0,t,z0),fr.p(u1,t,z0),fr.p(u1,t,z1),fr.p(u0,t,z1)],[(0,0)]*4,fr.o(0,1))

def _frame(fr,col,grille=False):
    """Casing in the reveal: two posts, head, transom rail, transom glass (or an iron grille on the studded door), sill."""
    for s in (-1,1):
        u0,u1=(0.72,0.83) if s>0 else (-0.83,-0.72)
        fbox(fr,u0,u1,-0.27,-0.12,F,ZT-0.02,col,top=False)
    fbox(fr,-0.83,0.83,-0.27,-0.12,ZT-0.12,ZT-0.02,col,top=False,bottom=True)               # head
    fbox(fr,-0.72,0.72,-0.27,-0.12,Z1,Z1+0.06,col)                                           # transom rail
    if grille:
        pquad("palette",fr.p(-0.72,-0.26,Z1+0.06),fr.p(0.72,-0.26,Z1+0.06),fr.p(0.72,-0.26,ZT-0.12),fr.p(-0.72,-0.26,ZT-0.12),"ink",fr.o(0,1))
        for k in range(6): u=-0.6+k*0.24; fbox(fr,u-0.012,u+0.012,-0.22,-0.2,Z1+0.06,ZT-0.12,"iron",top=False)
    else:
        _glass(fr,-0.72,0.72,Z1+0.06,ZT-0.12,-0.2)
        for u in (-0.24,0.24): fbox(fr,u-0.015,u+0.015,-0.23,-0.19,Z1+0.06,ZT-0.12,col,top=False)
    fbox(fr,-0.85,0.85,-0.30,-0.1,F,F+0.03,"stone_lt")                                       # threshold plate
def _kick(fr,u0,u1): fbox(fr,u0,u1,TF,TF+0.03,Z0+0.03,Z0+0.27,"brass",top=False)
def _mat(fr,col):    fbox(fr,-0.5,0.5,0.15,0.75,F,F+0.025,col)
def _step(fr,hw,t0,t1,h): fbox(fr,-hw,hw,t0,t1,0,h,"stone")

def door_static(st,fr):
    """Colour-independent geometry for style st at c = 0 (local frame, z from street level)."""
    _frame(fr,FRAME_COL[st],grille=(st==4))
    if st==0:                                                                                 # six-panel timber door
        _kick(fr,-0.6,0.6)
        fbox(fr,0.44,0.56,TR,TR+0.03,1.0,1.32,"brass",top=False)                              # backplate
        fbox(fr,0.47,0.53,TR+0.03,TR+0.09,1.1,1.16,"brass",top=False)                         # knob
        fbox(fr,-0.2,0.2,TR,TR+0.03,1.45,1.52,"brass",top=False)                              # letterbox
        _step(fr,1.45,0.85,1.25,0.14); _mat(fr,"wood")
    elif st==1:                                                                               # glazed shop door under a striped canopy
        _glass(fr,-0.6,0.6,0.80,2.28,-0.21); _kick(fr,-0.7,0.7)
        for s in (0.5,):
            fbox(fr,s-0.015,s+0.015,TF,TF+0.08,0.95,1.5,"brass",top=False)                    # long vertical pull
            for z in (1.0,1.45): fbox(fr,s-0.02,s+0.02,TF,TF+0.09,z-0.02,z+0.02,"iron",top=False)
        t0,t1,z0,z1,z2=0.16,1.0,3.12,2.80,2.62                                                # canopy: wall edge, front edge, heights
        n=8
        for k in range(n):
            u0=-1.0+k*0.25; u1=u0+0.25; c="cream" if k%2 else "cloth_gold"
            pquad("palette",fr.p(u0,t0,z0),fr.p(u1,t0,z0),fr.p(u1,t1,z1),fr.p(u0,t1,z1),c,(0,0,1))
            pquad("palette",fr.p(u0,t0,z0-0.02),fr.p(u1,t0,z0-0.02),fr.p(u1,t1,z1-0.02),fr.p(u0,t1,z1-0.02),c,(0,0,-1))
            pquad("palette",fr.p(u0,t1,z1),fr.p(u1,t1,z1),fr.p(u1,t1,z2),fr.p(u0,t1,z2),c,fr.o(0,1))
            pquad("palette",fr.p(u0,t1-0.02,z1),fr.p(u1,t1-0.02,z1),fr.p(u1,t1-0.02,z2),fr.p(u0,t1-0.02,z2),c,fr.o(0,-1))
        for s in (-1,1):
            for o in (1,-1): ptri("palette",fr.p(s,t0,z0-0.02),fr.p(s,t1,z1-0.02),fr.p(s,t0,z1-0.02),"cream",fr.o(o,0))
        rod(fr,(0,0.6,2.96),(0,0.6,2.78),0.02,"iron")                                         # chain
        fbox(fr,-0.09,0.09,0.51,0.69,2.50,2.78,"lamp",b="lamp_glow",top=False); fbox(fr,-0.11,0.11,0.49,0.71,2.78,2.82,"iron")
        fbox(fr,-0.11,0.11,0.49,0.71,2.46,2.50,"iron",top=False,bottom=True)
        _mat(fr,"iron")
    elif st==2:                                                                               # double door, tall glazed panes
        _glass(fr,-0.62,-0.11,1.0,2.28,-0.21); _glass(fr,0.11,0.62,1.0,2.28,-0.21); _kick(fr,-0.66,-0.04); _kick(fr,0.04,0.66)
        for s in (-1,1):
            fbox(fr,s*0.1-0.012,s*0.1+0.012,TF,TF+0.08,0.95,1.55,"brass",top=False)
            for z in (1.0,1.5): fbox(fr,s*0.1-0.02,s*0.1+0.02,TF,TF+0.09,z-0.02,z+0.02,"brass",top=False)
        _step(fr,1.5,0.85,1.3,0.14); _step(fr,1.7,1.3,1.65,0.07); _mat(fr,"terracotta")
    elif st==3:                                                                               # half-glazed lattice door under a pent roof
        _glass(fr,-0.62,0.62,1.35,2.3,-0.21); _kick(fr,-0.6,0.6)
        fbox(fr,0.5,0.56,TF,TF+0.06,1.0,1.06,"brass",top=False); fbox(fr,0.51,0.55,TF+0.06,TF+0.1,1.02,1.04,"brass",top=False)   # knob + boss
        fbox(fr,-0.05,0.05,TR,TR+0.03,1.1,1.14,"iron",top=False)                              # letter slot
        t0,t1,z0,z1=0.16,0.95,3.12,2.84; n=6
        for k in range(n):
            u0=-1.1+k*(2.2/n); u1=u0+2.2/n; c="terracotta" if k%2 else "brick"
            pquad("palette",fr.p(u0,t0,z0),fr.p(u1,t0,z0),fr.p(u1,t1,z1),fr.p(u0,t1,z1),c,(0,0,1))
            pquad("palette",fr.p(u0,t0,z0-0.04),fr.p(u1,t0,z0-0.04),fr.p(u1,t1,z1-0.04),fr.p(u0,t1,z1-0.04),"wood_dark",(0,0,-1))
        fbox(fr,-1.1,1.1,t1-0.02,t1+0.05,z1-0.08,z1+0.02,"wood_dark")                         # fascia board
        for s in (-1,1):
            rod(fr,(s*0.98,0.2,2.45),(s*0.98,0.88,2.82),0.06,"wood_dark"); fbox(fr,s*0.98-0.03,s*0.98+0.03,0.16,0.22,2.45,3.12,"wood_dark",top=False)
        _step(fr,1.45,0.85,1.25,0.14); _mat(fr,"wood")
    else:                                                                                     # studded plank door, iron straps, ring pull
        fbox(fr,-HW,HW,TB,TB+0.02,Z0,Z1,"wood_dark",top=False)                                # dark backing seen through the plank joints
        for z0_,z1_ in ((0.55,0.68),(1.95,2.08)):
            fbox(fr,-0.7,0.7,TR,TR+0.03,z0_,z1_,"iron",top=False)                             # straps
            for k in range(7):
                u=-0.6+k*0.2; zc=(z0_+z1_)/2
                for (a,b,c_,d_) in ((-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,-1)):
                    ptri("palette",fr.p(u+a*0.035,TR+0.03,zc+b*0.035),fr.p(u+c_*0.035,TR+0.03,zc+d_*0.035),fr.p(u,TR+0.075,zc),"brass",fr.o((a+c_)*0.5,1,(b+d_)*0.5))
        fbox(fr,0.35,0.55,TR,TR+0.03,1.1,1.3,"iron",top=False)                                # ring backplate
        for k in range(8):                                                                    # ring: flat octagonal band, faces out
            a0=2*math.pi*k/8; a1=2*math.pi*(k+1)/8; ru,rz=0.45,1.2
            pq=lambda r,a:fr.p(ru+r*math.cos(a),TR+0.07,rz+r*math.sin(a))
            pquad("palette",pq(0.05,a0),pq(0.05,a1),pq(0.075,a1),pq(0.075,a0),"brass",fr.o(0,1))
        _step(fr,1.55,0.85,1.2,0.19); _step(fr,1.75,1.2,1.5,0.09)
    # number plaque on the wall to the right of the door (digits are added per door)
    fbox(fr,1.58,1.92,0.0,0.04,1.5,1.72,"ink",top=True)
    fbox(fr,1.56,1.94,0.0,0.03,1.48,1.50,"brass",top=False); fbox(fr,1.56,1.94,0.0,0.03,1.72,1.74,"brass",top=False)

def _bead(fr,c,u0,u1,z0,z1,col="cream",t=TR+0.02,i=0.05,w=0.03):
    """Painted moulding line round a raised panel (4 flat strips, 2 cm proud): without it same-colour panels read as one flat sheet."""
    a0,a1,b0,b1=c+u0+i,c+u1-i,z0+i,z1-i; o=fr.o(0,1)
    for (x0,x1,y0,y1) in ((a0,a1,b0,b0+w),(a0,a1,b1-w,b1),(a0,a0+w,b0+w,b1-w),(a1-w,a1,b0+w,b1-w)):
        pquad("palette",fr.p(x0,t,y0),fr.p(x1,t,y0),fr.p(x1,t,y1),fr.p(x0,t,y1),col,o)

def door_leaf(st,fr,c,col):
    """Colour-dependent leaf, built in the world frame with the colour palette entry `col`."""
    B=lambda u0,u1,t0,t1,z0,z1,top=False:fbox(fr,c+u0,c+u1,t0,t1,z0,z1,col,top=top)
    if st==0:
        B(-HW,HW,TB,TF,Z0,Z1)
        for (u0,u1) in ((-0.58,-0.06),(0.06,0.58)):
            for (z0,z1) in ((0.55,1.15),(1.3,2.25)): B(u0,u1,TF,TR,z0,z1,True); _bead(fr,c,u0,u1,z0,z1)
    elif st==1:
        B(-HW,-0.6,TB,TF,Z0,Z1); B(0.6,HW,TB,TF,Z0,Z1); B(-0.6,0.6,TB,TF,Z0,0.80); B(-0.6,0.6,TB,TF,2.28,Z1)
        B(-0.02,0.02,TB,TF,0.8,2.28); B(-0.6,0.6,TB,TF,1.53,1.57)
    elif st==2:
        for s in (-1,1):
            ua,ub=(0.012,HW) if s>0 else (-HW,-0.012)
            B(ua,ub,TB,TF,Z0,1.0); B(ua,ub,TB,TF,2.28,Z1)
            if s>0: B(0.012,0.11,TB,TF,1.0,2.28); B(0.62,HW,TB,TF,1.0,2.28)
            else: B(-0.11,-0.012,TB,TF,1.0,2.28); B(-HW,-0.62,TB,TF,1.0,2.28)
            B(min(ua,ub)+0.1,max(ua,ub)-0.1,TF,TR,0.45,0.9,True); _bead(fr,c,min(ua,ub)+0.1,max(ua,ub)-0.1,0.45,0.9,i=0.04)
        B(-0.02,0.02,TF,TF+0.015,Z0,Z1)
    elif st==3:
        B(-HW,HW,TB,TF,Z0,1.35); B(-HW,-0.62,TB,TF,1.35,Z1); B(0.62,HW,TB,TF,1.35,Z1); B(-0.62,0.62,TB,TF,2.3,Z1)
        B(-0.58,0.58,TF,TR,0.5,1.2,True); _bead(fr,c,-0.58,0.58,0.5,1.2)
        for u in (-0.31,0,0.31): B(u-0.015,u+0.015,TB,TF,1.35,2.3)
        for z in (1.66,1.98): B(-0.62,0.62,TB,TF,z-0.015,z+0.015)
    else:
        for k in range(5):
            u0=-HW+k*(2*HW/5)+0.006; u1=-HW+(k+1)*(2*HW/5)-0.006; B(u0,u1,TB+0.03,TF,Z0,Z1,False)

SEG={"0":"abcdef","1":"bc","2":"abdeg","3":"abcdg","4":"bcfg","5":"acdfg","6":"acdefg","7":"abc","8":"abcdefg","9":"abcdfg"}
def digits(fr,c,num):
    """Seven-segment house number on the plaque (u 1.58..1.92, z 1.5..1.72), segments 2 cm proud of the plaque face."""
    s=str(num); w=0.075; h=0.065; th=0.016; gap=0.04; tot=len(s)*w+(len(s)-1)*gap; u0=c+1.75-tot/2; zc=1.61; t=0.065
    for i,ch in enumerate(s):
        ul=u0+i*(w+gap); ur=ul+w
        seg={"a":(ul,ur,zc+h-th,zc+h),"d":(ul,ur,zc-h,zc-h+th),"g":(ul,ur,zc-th/2,zc+th/2),
             "f":(ul,ul+th,zc,zc+h),"b":(ur-th,ur,zc,zc+h),"e":(ul,ul+th,zc-h,zc),"c":(ur-th,ur,zc-h,zc)}
        for k in SEG[ch]:
            a,b,z0,z1=seg[k]; pquad("palette",fr.p(a,t,z0),fr.p(b,t,z0),fr.p(b,t,z1),fr.p(a,t,z1),"paper",fr.o(0,1))

def entrance(fr,c,style,col,num):
    """Called from hero_ground at the door bay: leaf + digits into the shared buckets, static part queued as an instance."""
    door_leaf(style,fr,c,col); digits(fr,c,num)
    x,y=fr.xy(c,0.0); INST.append((style,x,y,fr.z0,math.atan2(fr.r[1],fr.r[0])))
