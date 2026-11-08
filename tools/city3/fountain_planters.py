"""Four shared-mesh, PBR planters assembled from reachable Poly Haven CC0 assets.

Keep the source mesh detail and normal/roughness maps: assets_kit.load() is
deliberately diffuse-only for the older stylized interiors and is not used here.
Source downloads remain under assets/polyhaven; assets/fetch.sh restores them.
"""
import math
from pathlib import Path

ASSETS = Path(__file__).parent / "assets" / "polyhaven"
CREDITS = [
    {"asset": "fountain_clay_planter", "author": "Amal Kumar", "license": "CC0",
     "source": "https://polyhaven.com/a/planter_pot_clay"},
    {"asset": "fountain_haworthia_and_gravel", "author": "James Ray Cock", "license": "CC0",
     "source": "https://polyhaven.com/a/potted_plant_04"},
]


def _load(asset):
    import bpy
    path = ASSETS / asset / f"{asset}_1k.gltf"
    if not path.is_file():
        raise FileNotFoundError(f"Missing {path}. Run tools/city3/assets/fetch.sh first.")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = [o for o in bpy.data.objects if o not in before]
    for obj in objects:
        if obj.type == "MESH":
            # Bake import transforms once; placement is in Blender metres.
            obj.data.transform(obj.matrix_world)
            obj.parent = None
            obj.matrix_world.identity()
    return objects


def _join(objects, name):
    import bpy
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = objects[0]
    obj.name = name
    obj.data.name = name
    return obj


def build(parent, positions, z=0.2):
    """Fit the original 0.66 m radius / 0.73 m tall collision envelope.

    Bases embed by 1 cm; gravel stays below the rim. Four placements reuse the
    same two meshes and texture sets, with deterministic rotations.
    """
    import bpy
    source = _load("planter_pot_clay")
    pot = _join([o for o in source if o.type == "MESH"], "FountainClayPot")
    vertices = pot.data.vertices
    low = [min(v.co[i] for v in vertices) for i in range(3)]
    high = [max(v.co[i] for v in vertices) for i in range(3)]
    cx, cy = [(low[i] + high[i]) / 2 for i in range(2)]
    radius = max(math.hypot(v.co.x-cx, v.co.y-cy) for v in vertices)
    for v in vertices:
        v.co = ((v.co.x-cx)*0.65/radius, (v.co.y-cy)*0.65/radius,
                (v.co.z-low[2])*0.73/(high[2]-low[2]) - 0.01)

    source = _load("potted_plant_04")
    # The source's white ceramic container is replaced by the clay pot.
    keep = [o for o in source if o.type == "MESH" and
            any(o.name.startswith(f"potted_plant_04_{role}") for role in ("plant", "ground", "dirt"))]
    if len(keep) != 3:
        raise ValueError("Poly Haven plant structure changed; inspect before rebuilding")
    for obj in source:
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)
    foliage = _join(keep, "FountainHaworthiaGravel")
    # The source's soil line is z=.144 m. Uniform scaling preserves leaf form;
    # 0.61 m above paving leaves the gravel recessed below the 0.72 m rim.
    for v in foliage.data.vertices:
        v.co = (v.co.x*5.5, v.co.y*5.5, (v.co.z-.144)*5.5+.61)

    for master in (pot, foliage):
        master.data.update()
        for i, (x, y) in enumerate(positions):
            obj = master if i == 0 else bpy.data.objects.new(f"{master.name}_{i}", master.data)
            if i:
                bpy.context.scene.collection.objects.link(obj)
            obj.parent = parent
            obj.location = (x, y, z)
            obj.rotation_euler = (0, 0, i*1.37)
    return pot, foliage
