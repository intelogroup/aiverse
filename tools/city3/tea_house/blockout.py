"""Blender-only structure from plan.json. Always launch through blender_lock.sh.
No scripts or drivers from the source are executed; source import is glTF only.
"""
import bpy
import json
import math
import os
from pathlib import Path
from collections import defaultdict
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/procedural-city/tea-house'
P=json.loads((OUT/'plan.json').read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.unit_settings.system='METRIC'
scene.unit_settings.scale_length=1

def collection(name):
    c=bpy.data.collections.new(name);scene.collection.children.link(c);return c

reference=collection('00_EXISTING_ENVELOPE_REFERENCE')
bpy.ops.import_scene.gltf(filepath=str(OUT/'existing-shell.glb'))
for o in list(scene.objects):
    for c in list(o.users_collection):c.objects.unlink(o)
    reference.objects.link(o)
reference.hide_render=True
reference.hide_viewport=True

palette={
 'slab':(.75,.76,.72,1),'shell':(.81,.79,.70,1),'partition':(.85,.85,.79,1),
 'stair':(.65,.34,.23,1),'wet':(.41,.64,.70,1),'lift':(.30,.52,.65,1),
 'door':(.44,.40,.31,1),'bar':(.50,.34,.20,1),'service':(.49,.55,.53,1),'stairwall':(.65,.34,.23,1),
}
materials={}
for key,color in palette.items():
    m=bpy.data.materials.new('Structure_'+key);m.diffuse_color=color;m.use_nodes=True
    m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=color
    m.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.85
    materials[key]=m

# Each box is 12 triangles. No subdivision, bevel, high-poly props or baked textures.
parts=defaultdict(lambda:([],[]))
def box(group,kind,x0,y0,z0,x1,y1,z1):
    if min(x1-x0,y1-y0,z1-z0)<1e-6:return
    vs,fs=parts[(group,kind)];i=len(vs)
    vs.extend([(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)])
    fs.extend([tuple(i+k for k in f) for f in [(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]])

def wall(group,kind,axis,at,start,end,z0,z1,openings=(),thick=.12):
    """Rectangular wall cells with actual door/window openings, including their lintels."""
    xs=sorted({start,end,*(max(start,min(end,a)) for op in openings for a in op[:2])})
    zs=sorted({z0,z1,*(max(z0,min(z1,a)) for op in openings for a in op[2:])})
    for a,b in zip(xs,xs[1:]):
        for c,d in zip(zs,zs[1:]):
            if any(lo<(a+b)/2<hi and bot<(c+d)/2<top for lo,hi,bot,top in openings):continue
            if axis=='u':box(group,kind,at-thick/2,a,c,at+thick/2,b,d)
            else:box(group,kind,a,at-thick/2,c,b,at+thick/2,d)

def slab(group,y,holes):
    xs=sorted({0,25,*(r[k] for r in holes for k in (0,2))})
    ds=sorted({0,12,*(r[k] for r in holes for k in (1,3))})
    for a,b in zip(xs,xs[1:]):
        for c,d in zip(ds,ds[1:]):
            if any(r[0]<(a+b)/2<r[2] and r[1]<(c+d)/2<r[3] for r in holes):continue
            box(group,'slab',a,c,y-.18,b,d,y)

def internal_walls(l,top):
    rooms=l['rooms']; bounds=defaultdict(list)
    us=sorted({r['rect'][k] for r in rooms for k in (0,2)})
    ds=sorted({r['rect'][k] for r in rooms for k in (1,3)})
    def owner(u,d):return next((r for r in rooms if r['rect'][0]<u<r['rect'][2] and r['rect'][1]<d<r['rect'][3]),None)
    for axis,coords,others in [('u',us,ds),('d',ds,us)]:
        for at in coords[1:-1]:
            for a,b in zip(others,others[1:]):
                r0=owner(at-.001,(a+b)/2) if axis=='u' else owner((a+b)/2,at-.001)
                r1=owner(at+.001,(a+b)/2) if axis=='u' else owner((a+b)/2,at+.001)
                if not r0 or not r1 or r0['wallGroup']==r1['wallGroup']:continue
                bounds[(axis,at,r0['id'],r1['id'])].append((a,b))
    lookup={r['id']:r for r in rooms}
    for (axis,at,id0,id1),segments in bounds.items():
        r0=lookup[id0];r1=lookup[id1]
        merged=[]
        for a,b in segments:
            if merged and abs(merged[-1][1]-a)<1e-6:merged[-1]=(merged[-1][0],b)
            else:merged.append((a,b))
        core=r0['kind'] in ('stair','lift','shaft') or r1['kind'] in ('stair','lift','shaft')
        thick=.20 if core else .12
        kind='lift' if 'lift' in (r0['kind'],r1['kind']) else ('wet' if 'wet' in (r0['kind'],r1['kind']) else ('stairwall' if core else 'partition'))
        # Keep circulation zones fully clear: place wall thickness into the neighbouring room.
        offset=(-thick/2 if r1['kind']=='circulation' else thick/2 if r0['kind']=='circulation' else 0)
        doors=[d for d in l['doors'] if {d['a'],d['b']}=={id0,id1}]
        openings=[(d['center']-d['width']/2,d['center']+d['width']/2,l['floorY'],l['floorY']+2.25) for d in doors]
        for a,b in merged:wall(l['id'],kind,axis,at+offset,a,b,l['floorY'],top,openings,thick)

levels=P['levels']
for i,l in enumerate(levels):
    y=l['floorY'];top=(levels[i+1]['floorY'] if i<3 else 14.9)-.18
    holes=[r['rect'] for r in l['rooms'] if r['kind']=='lift' or (i>0 and r['kind']=='stair')]
    slab(l['id'],y,holes)
    internal_walls(l,top)
    # External shell: both side party walls have no openings.
    wall(l['id'],'shell','u',.15,0,12,y,top,thick=.3)
    wall(l['id'],'shell','u',24.85,0,12,y,top,thick=.3)
    front=[]
    for k in range(6):
        center=(k+.5)*25/6
        if i==0 and k in (0,3,5):continue
        front.append((center-1.3,center+1.3,y+.80,y+2.55))
    if i==0:
        for d in l['doors']:
            if d['a']=='street':front.append((d['center']-d['width']/2,d['center']+d['width']/2,y,y+2.4))
    wall(l['id'],'shell','d',.15,0,25,y,top,front,.3)
    # Only the western rear frontage faces open courtyard; eastern rear is a party wall.
    rear=[(x-1,x+1,y+1.0,y+2.45) for x in (2.3,6.5,10.65)]
    wall(l['id'],'shell','d',11.85,0,25,y,top,rear,.3)
    for d in l['doors']:
        if d['a']=='street' or 'riser' in d['b']:continue
        # Door leaf shown open, with a simple jamb. Elevator gets closed twin panels.
        if d['b']=='lift':
            for side in (-1,1):
                center=d['center']+side*d['width']/4
                box(l['id'],'lift',center-d['width']/4+.015,d['at']+.03,y,center+d['width']/4-.015,d['at']+.08,y+2.2)
        elif d['axis']=='d':
            u=d['center']-d['width']/2
            box(l['id'],'door',u,d['at']+.04,y,u+.045,d['at']+d['width'],y+2.2)
        else:
            d0=d['center']-d['width']/2
            box(l['id'],'door',d['at']+.04,d0,y,d['at']+d['width'],d0+.045,y+2.2)
    # Simple repeating wet ducts, stacked through the two residential storeys.
    if i>=2:
        for u in P['proposal']['secondaryWetStacksU']:
            box(l['id'],'service',u-.10,3.95,y,u+.10,4.15,top)

# Stair runs and landings; the slab voids are actual openings, not painted marks.
stair_metrics=[]
for i in range(3):
    y=levels[i]['floorY'];upper=levels[i+1]['floorY'];n=P['proposal']['stairRisers'][i];half=n//2;rise=(upper-y)/n;run=(half-1)*.28
    for r in [r for r in levels[i]['rooms'] if r['kind']=='stair']:
        x0,d0,x1,d1=r['rect'];s=d0+1.45;end=s+run
        box(levels[i]['id'],'stair',x0+.2,d0,y-.18,x1-.2,s,y)
        box(levels[i]['id'],'stair',x0+.2,end,y+half*rise-.18,x1-.2,d1,y+half*rise)
        box(levels[i+1]['id'],'stair',x0+.2,d0,upper-.18,x1-.2,s,upper)
        for k in range(half-1):
            box(levels[i]['id'],'stair',x0+.45,s+k*.28,y,x0+1.70,s+(k+1)*.28,y+(k+1)*rise)
            box(levels[i]['id'],'stair',x0+1.95,end-(k+1)*.28,y+half*rise,x0+3.20,end-k*.28,y+(half+k+1)*rise)
        stair_metrics.append(dict(id=r['id'],fromLevel=levels[i]['id'],toLevel=levels[i+1]['id'],risers=n,riserHeight=rise,going=.28,run=run,frontLanding=1.25,rearLanding=d1-end,flightWidth=1.25))

# Ground bar and four shelf carcasses are boxes only; no bottles or furniture detailing.
for u in P['proposal']['counterCentersU']:
    box('G','bar',u-.85,8.28,.48,u+.85,9.42,1.60)
for u in P['proposal']['shelfCentersU']:
    box('G','bar',u-.98,11.35,.48,u+.98,11.55,3.45)
    for z in (1.63,2.33,3.03):box('G','bar',u-.98,10.95,z-.06,u+.98,11.55,z)

# Structural pit and simple entrance grading; no working lift or door animation yet.
box('G','lift',17,8.5,-.70,19.7,11.7,-.52)
for axis,at,a,b in [('u',17,8.5,11.7),('u',19.7,8.5,11.7),('d',8.5,17,19.7),('d',11.7,17,19.7)]:
    wall('G','lift',axis,at,a,b,-.52,.48,thick=.2)
a,b,c,d=P['proposal']['entranceLanding'];box('G','slab',a,b,.2,c,d,.48)
a,b,c,d=P['proposal']['entranceRamp'];vs,fs=parts[('G','slab')];base=len(vs)
vs.extend([(a,b,.15),(c,b,.15),(c,d,.15),(a,d,.15),(a,b,.2),(c,b,.48),(c,d,.48),(a,d,.2)])
fs.extend([tuple(base+k for k in f) for f in [(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]])
for u in (1.2,23.8):
    box('G','slab',u-.7,-.6,.2,u+.7,-.3,.34)
    box('G','slab',u-.7,-.3,.2,u+.7,0,.48)

# Roof deck has an opening for lift overrun; pitched roof itself reuses the surveyed mesh.
slab('ATTIC',14.9,[[17,8.5,19.7,11.7]])
wall('ATTIC','lift','u',17,8.5,11.7,14.72,15.2,thick=.2)
wall('ATTIC','lift','u',19.7,8.5,11.7,14.72,15.2,thick=.2)
wall('ATTIC','lift','d',8.5,17,19.7,14.72,15.2,thick=.2)
wall('ATTIC','lift','d',11.7,17,19.7,14.72,15.2,thick=.2)
box('ATTIC','lift',16.9,8.4,15.05,19.8,11.8,15.2)

collections={l['id']:collection(f'{l["id"]}_{l["name"]}') for l in levels}
collections['ATTIC']=collection('ATTIC_ROOF_SERVICE_ONLY')
objects=[]
for (group,kind),(vs,fs) in parts.items():
    mesh=bpy.data.meshes.new(f'{group}_{kind}');mesh.from_pydata(vs,[],fs);mesh.update()
    o=bpy.data.objects.new(f'{group}_{kind}',mesh);collections[group].objects.link(o);o.data.materials.append(materials[kind]);o.color=palette[kind]
    o['level']=group;o['category']=kind;o['concept_only']=True
    objects.append(o)
for original in reference.objects:
    if original.type=='MESH' and original.name.startswith('RoofTileV4'):
        roof=original.copy();roof.data=original.data.copy();collections['ATTIC'].objects.link(roof);roof.name='EXISTING_PITCHED_ROOF';roof.hide_render=False;objects.append(roof)

# Export assembled proposal only, not the reference city subset or drawing duplicates.
bpy.ops.object.select_all(action='DESELECT')
for o in objects:o.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
bpy.ops.export_scene.gltf(filepath=str(OUT/'proposed-structure.glb'),export_format='GLB',use_selection=True,export_extras=True,export_apply=True)

triangles=sum(len(p.vertices)-2 for o in objects for p in o.data.polygons)
metrics=dict(triangles=triangles,objects=len(objects),source='plan.json',stairs=stair_metrics,openings='real omitted wall cells and slab voids',detail='boxes and original six-triangle roof only',liveWorldModified=False)
(OUT/'blockout-metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')

# Exploded low-wall presentation; assembled geometry remains in the editable file.
presentation=collection('PRESENTATION_EXPLODED_CUTAWAY')
for i,l in enumerate(levels):
    for original in collections[l['id']].objects:
        o=original.copy();o.data=original.data.copy();presentation.objects.link(o)
        if original.get('category') in ('shell','partition','wet','lift','service','stairwall'):
            for v in o.data.vertices:v.co.z=min(v.co.z,l['floorY']+1.05)
        o.location.z+=i*2.6
for c in collections.values():c.hide_render=True
scene.render.engine='BLENDER_WORKBENCH'
scene.display.shading.light='STUDIO';scene.display.shading.color_type='MATERIAL'
scene.display.shading.show_shadows=True;scene.display.shading.show_cavity=True
scene.display.shading.cavity_type='BOTH';scene.display.shading.show_object_outline=True
scene.display.shading.background_type='WORLD';scene.world=bpy.data.worlds.new('Study background');scene.world.color=(.82,.82,.80)
scene.render.resolution_x=1450;scene.render.resolution_y=1350;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
camera_data=bpy.data.cameras.new('Overview');camera=bpy.data.objects.new('Overview',camera_data);scene.collection.objects.link(camera);scene.camera=camera
camera.location=(40,-42,40);target=Vector((12.5,6,10.5));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera_data.type='ORTHO';camera_data.ortho_scale=39
scene.render.filepath=str(OUT/'structure-exploded.png')
bpy.ops.render.render(write_still=True)
# Save native file in assembled mode, with presentation available as a named collection.
presentation.hide_render=True;presentation.hide_viewport=True
for c in collections.values():c.hide_render=False
scene.render.filepath=str(OUT/'structure-assembled.png')
camera.location=(36,-40,29);target=Vector((12.5,6,8));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera_data.ortho_scale=33
bpy.ops.render.render(write_still=True)
for c in collections.values():c.hide_render=True
reference.hide_render=False
scene.render.filepath=str(OUT/'existing-envelope.png')
bpy.ops.render.render(write_still=True)
reference.hide_render=True
for c in collections.values():c.hide_render=False
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'tea-house-structure.blend'))
print('STRUCTURE COMPLETE',json.dumps(metrics),flush=True)
os._exit(0)
