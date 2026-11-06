"""Geometry kit shared by the city builder (runs inside Blender's Python)."""
import json, math, os
from contextlib import contextmanager
from mathutils import Vector
HERE=os.path.dirname(os.path.abspath(__file__))
PAL=json.load(open(f"{HERE}/palette.json")); ATL=json.load(open(f"{HERE}/atlas.json"))
class MB:
    def __init__(s): s.v=[]; s.m={}; s.f=[]; s.uv=[]
    def vi(s,p):
        k=(round(p[0],3),round(p[1],3),round(p[2],3))
        if k not in s.m: s.m[k]=len(s.v); s.v.append(k)
        return s.m[k]
    def tri(s,a,b,c,ua,ub,uc,out=None):
        A,B,C=Vector(a),Vector(b),Vector(c); n=(B-A).cross(C-A)
        if n.length<1e-7: return
        if out is not None and n.dot(Vector(out))<0: b,c,ub,uc=c,b,uc,ub
        s.f.append((s.vi(a),s.vi(b),s.vi(c))); s.uv.append((ua,ub,uc))
    def quad(s,a,b,c,d,ua,ub,uc,ud,out=None):
        s.tri(a,b,c,ua,ub,uc,out); s.tri(a,c,d,ua,uc,ud,out)
MBS={}; _G=[None]
@contextmanager
def grp(name):
    old=_G[0]; _G[0]=name
    try: yield
    finally: _G[0]=old
def mb(name):
    key=name if _G[0] is None else f"{_G[0]}::{name}"
    if key not in MBS: MBS[key]=MB()
    return MBS[key]
def pal_uv(name): i=PAL[name]; c,r=i%8,i//8; return ((c*8+4)/64.0,1-(r*8+4)/64.0)
def pquad(b,a,bb,c,d,color,out=None): u=pal_uv(color); mb(b).quad(a,bb,c,d,u,u,u,u,out)
def ptri(b,a,bb,c,color,out=None): u=pal_uv(color); mb(b).tri(a,bb,c,u,u,u,out)
def tq(b,pts,uvs,out=None): mb(b).quad(pts[0],pts[1],pts[2],pts[3],uvs[0],uvs[1],uvs[2],uvs[3],out)
def pbox(x0,y0,x1,y1,z0,z1,color,b="palette",bottom=False):
    pquad(b,(x0,y0,z0),(x1,y0,z0),(x1,y0,z1),(x0,y0,z1),color,(0,-1,0))
    pquad(b,(x1,y0,z0),(x1,y1,z0),(x1,y1,z1),(x1,y0,z1),color,(1,0,0))
    pquad(b,(x1,y1,z0),(x0,y1,z0),(x0,y1,z1),(x1,y1,z1),color,(0,1,0))
    pquad(b,(x0,y1,z0),(x0,y0,z0),(x0,y0,z1),(x0,y1,z1),color,(-1,0,0))
    pquad(b,(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1),color,(0,0,1))
    if bottom: pquad(b,(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),color,(0,0,-1))
def cyl(cx,cy,z0,z1,r,seg,color,b="palette",top=True,r1=None):
    r1=r if r1 is None else r1
    for k in range(seg):
        a0=2*math.pi*k/seg; a1=2*math.pi*(k+1)/seg; am=(a0+a1)/2
        pquad(b,(cx+r*math.cos(a0),cy+r*math.sin(a0),z0),(cx+r*math.cos(a1),cy+r*math.sin(a1),z0),(cx+r1*math.cos(a1),cy+r1*math.sin(a1),z1),(cx+r1*math.cos(a0),cy+r1*math.sin(a0),z1),color,(math.cos(am),math.sin(am),0))
        if top: ptri(b,(cx,cy,z1),(cx+r1*math.cos(a0),cy+r1*math.sin(a0),z1),(cx+r1*math.cos(a1),cy+r1*math.sin(a1),z1),color,(0,0,1))
class Frame:
    """Wall-local frame: u along the wall, t out of it (negative = inside), z up."""
    def __init__(s,a,r,n,z0=0.0): s.a=a; s.r=r; s.n=n; s.z0=z0
    def p(s,u,t,z): return (s.a[0]+s.r[0]*u+s.n[0]*t, s.a[1]+s.r[1]*u+s.n[1]*t, z+s.z0)
    def o(s,du,dt,dz=0.0): return (s.r[0]*du+s.n[0]*dt, s.r[1]*du+s.n[1]*dt, dz)
    def xy(s,u,t): q=s.p(u,t,0); return q[0],q[1]
def fbox(fr,u0,u1,t0,t1,z0,z1,color,b="palette",top=True,bottom=False,back=False):
    P=fr.p
    pquad(b,P(u0,t1,z0),P(u1,t1,z0),P(u1,t1,z1),P(u0,t1,z1),color,fr.o(0,1))
    pquad(b,P(u0,t1,z0),P(u0,t0,z0),P(u0,t0,z1),P(u0,t1,z1),color,fr.o(-1,0))
    pquad(b,P(u1,t0,z0),P(u1,t1,z0),P(u1,t1,z1),P(u1,t0,z1),color,fr.o(1,0))
    if top: pquad(b,P(u0,t0,z1),P(u1,t0,z1),P(u1,t1,z1),P(u0,t1,z1),color,(0,0,1))
    if bottom: pquad(b,P(u0,t0,z0),P(u1,t0,z0),P(u1,t1,z0),P(u0,t1,z0),color,(0,0,-1))
    if back: pquad(b,P(u0,t0,z0),P(u1,t0,z0),P(u1,t0,z1),P(u0,t0,z1),color,fr.o(0,-1))
def frame_for(r,side,z0=0.0):
    x0,y0,x1,y1=r
    if side=="S": return Frame((x0,y0),(1,0),(0,-1),z0),x1-x0
    if side=="E": return Frame((x1,y0),(0,1),(1,0),z0),y1-y0
    if side=="N": return Frame((x1,y1),(-1,0),(0,1),z0),x1-x0
    return Frame((x0,y1),(0,-1),(-1,0),z0),y1-y0
PROF={}
def total(): return sum(len(b.f) for b in MBS.values())
def prof(name,fn):
    def w(*a,**k):
        t0=total(); r=fn(*a,**k); PROF[name]=PROF.get(name,0)+total()-t0; return r
    return w
