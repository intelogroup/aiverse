"""Look at a collision GLB (Workbench, flat colours per bucket):  blender -b --python colprev.py -- <glb> <tag> <view> [<view> ...]
view = top | iso | x,y,z:tx,ty,tz[:lens]   (plan metres, Blender frame; the glTF importer undoes the y-up export).  -> out/colprev_<tag>_<view>.png"""
import bpy, math, sys, os
from mathutils import Vector
HERE=os.path.dirname(os.path.abspath(__file__)); a=sys.argv[sys.argv.index("--")+1:]; glb,tag,views=a[0],a[1],a[2:]
bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.gltf(filepath=glb); s=bpy.context.scene
s.render.engine="BLENDER_WORKBENCH"; s.render.resolution_x=1200; s.render.resolution_y=800
sh=s.display.shading; sh.light="STUDIO"; sh.color_type="OBJECT"; sh.show_cavity=False; sh.background_type="VIEWPORT"; sh.background_color=(0.82,0.88,0.95)
XR=os.environ.get("XRAY")
if XR: sh.show_xray=True; sh.xray_alpha=float(XR)
s.view_settings.view_transform="Standard"; s.display.render_aa="8"
COL={"ground":(0.35,0.62,0.35),"quay":(0.9,0.2,0.2),"buildings":(0.8,0.75,0.6),"heroes":(0.85,0.55,0.25),"stalls":(0.4,0.4,0.9),"fountain":(0.2,0.7,0.9),"props":(0.7,0.2,0.7)}
for o in bpy.data.objects:
    if o.type=="MESH": o.color=(*COL.get(o.name.replace("col_","").split(".")[0],(0.7,0.7,0.7)),1)
import json, bmesh
for rid in [r for r in os.environ.get("COLJSON","").split(",") if r]:        # furniture boxes of those rooms (three -> Blender: y = -z)
    doc=json.load(open(f"{HERE}/out/interiors/{rid}.col.json"))
    for (cx,cz,hx,hz,y0,y1,rot) in doc["boxes"]:
        bm=bmesh.new(); bmesh.ops.create_cube(bm,size=1.0); me=bpy.data.meshes.new("fb"); bm.to_mesh(me); bm.free()
        ob=bpy.data.objects.new("fb",me); s.collection.objects.link(ob); ob.scale=(2*hx,2*hz,y1-y0); ob.location=(cx,-cz,(y0+y1)/2); ob.rotation_euler=(0,0,rot); ob.color=(0.9,0.1,0.1,1)
    for (sx,sz) in doc.get("seats",[]):
        bm=bmesh.new(); bmesh.ops.create_cube(bm,size=0.15); me=bpy.data.meshes.new("seat"); bm.to_mesh(me); bm.free()
        ob=bpy.data.objects.new("seat",me); s.collection.objects.link(ob); ob.location=(sx,-sz,doc["floorY"]+0.8); ob.color=(0.1,0.9,0.1,1)
def shot(t,loc,tgt,ortho=None,lens=30):
    cd=bpy.data.cameras.new(t); cam=bpy.data.objects.new(t,cd); s.collection.objects.link(cam); cam.location=loc
    cam.rotation_euler=(Vector(tgt)-Vector(loc)).to_track_quat("-Z","Y").to_euler(); cd.lens=lens; cd.clip_end=4000
    if ortho: cd.type="ORTHO"; cd.ortho_scale=ortho
    s.camera=cam; s.render.filepath=f"{HERE}/out/colprev_{tag}_{t}.png"; bpy.ops.render.render(write_still=True); print("RENDERED",s.render.filepath)
for v in views:
    if v=="top": shot("top",(0,0,700),(0,0,0),ortho=400)
    elif v=="iso": shot("iso",(300,-420,300),(0,0,40),lens=35)
    else:
        p=v.split(":"); loc=tuple(map(float,p[0].split(","))); tg=tuple(map(float,p[1].split(","))); lens=float(p[2]) if len(p)>2 else 30
        shot(v.replace(",","_").replace(":","-").replace(".","p"),loc,tg,lens=lens)
