"""Blender preview renders of a district .blend:  blender -b --python mprev.py -- <name> <view> [<view> ...]
views: top | iso | x,y,z:tx,ty,tz[:lens]   (district-local metres).  Writes out/prev_<name>_<view>.png. EEVEE, sky-blue world, one sun."""
import bpy, math, sys, os
from mathutils import Vector
HERE=os.path.dirname(os.path.abspath(__file__)); a=sys.argv[sys.argv.index("--")+1:]; name=a[0]; views=a[1:]
bpy.ops.wm.open_mainfile(filepath=f"{HERE}/out/{name}.blend"); s=bpy.context.scene
s.render.engine="BLENDER_EEVEE"; s.render.resolution_x=1200; s.render.resolution_y=750; s.eevee.taa_render_samples=6
w=bpy.data.worlds.new("w"); w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.55,0.7,0.92,1); w.node_tree.nodes["Background"].inputs[1].default_value=1.0; s.world=w
sun=bpy.data.objects.new("sun",bpy.data.lights.new("sun","SUN")); sun.data.energy=3.5; sun.rotation_euler=(math.radians(52),0,math.radians(35)); s.collection.objects.link(sun)
s.view_settings.view_transform="AgX"
def shot(tag,loc,tgt,ortho=None,lens=30):
    cd=bpy.data.cameras.new(tag); cam=bpy.data.objects.new(tag,cd); s.collection.objects.link(cam); cam.location=loc
    cam.rotation_euler=(Vector(tgt)-Vector(loc)).to_track_quat("-Z","Y").to_euler(); cd.lens=lens; cd.clip_end=3000
    if ortho: cd.type="ORTHO"; cd.ortho_scale=ortho
    s.camera=cam; s.render.filepath=f"{HERE}/out/prev_{name}_{tag}.png"; bpy.ops.render.render(write_still=True); print("RENDERED",s.render.filepath)
for v in views:
    if v=="top": shot("top",(0,0,700),(0,0,0),ortho=380)
    elif v=="iso": shot("iso",(300,-420,300),(0,0,60),lens=35)
    else:
        p=v.split(":"); loc=tuple(map(float,p[0].split(","))); tgt=tuple(map(float,p[1].split(","))); lens=float(p[2]) if len(p)>2 else 30
        shot(v.replace(",","_").replace(":","-").replace(".","p"),loc,tgt,lens=lens)
