import bpy, math, sys, os
from mathutils import Vector
HERE=os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.open_mainfile(filepath=f"{HERE}/out/city3.blend")
s=bpy.context.scene
s.render.engine="BLENDER_EEVEE"; s.render.resolution_x=1400; s.render.resolution_y=1000
w=bpy.data.worlds.new("w"); w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.62,0.74,0.9,1); w.node_tree.nodes["Background"].inputs[1].default_value=1.0; s.world=w
sun=bpy.data.objects.new("sun",bpy.data.lights.new("sun","SUN")); sun.data.energy=4.0; sun.rotation_euler=(math.radians(50),0,math.radians(35)); s.collection.objects.link(sun)
def shot(name,loc,target,ortho=None,lens=35):
    cd=bpy.data.cameras.new(name); cam=bpy.data.objects.new(name,cd); s.collection.objects.link(cam); cam.location=loc
    cam.rotation_euler=(Vector(target)-Vector(loc)).to_track_quat("-Z","Y").to_euler(); cd.lens=lens; cd.clip_end=3000
    if ortho: cd.type="ORTHO"; cd.ortho_scale=ortho
    s.camera=cam; s.render.filepath=f"{HERE}/out/prev_{name}.png"; bpy.ops.render.render(write_still=True)
which=sys.argv[sys.argv.index("--")+1:]
if "top" in which: shot("top",(0,0,600),(0,0,0),ortho=400)
if "iso" in which: shot("iso",(260,-330,230),(0,0,0),lens=32)
if "street" in which: shot("street",(-95,-28,6),(-40,10,8),lens=28)
if "plaza" in which: shot("plaza",(0,-75,14),(0,10,8),lens=28)

if "roof" in which: shot("roof",(-75,-65,50),(-45,-35,12),lens=40)
