"""Small, deterministic plaza refresh, usable by the generator or an imported city.

The coping sits on the existing rim; planters stand outside the basin and
share their positions with collision.py. No downloaded assets required.
"""
import math

NAME = "PlazaFountainGarden"


def planter_positions(outer_radius=10.0):
    """Keep 54 cm clear between the rim and each 66 cm-radius planter."""
    return [((outer_radius+1.7)*math.cos(i*math.pi/2),
             (outer_radius+1.7)*math.sin(i*math.pi/2)) for i in range(4)]


def build(z=0.2, outer_radius=10.0):
    """Replace our own object only; leave imported geometry and materials intact."""
    import bpy
    old = bpy.data.objects.get(NAME)
    if old:
        mesh = old.data
        bpy.data.objects.remove(old, do_unlink=True)
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    colors = [(0.72, 0.60, 0.41, 1), (0.035, 0.32, 0.29, 1),
              (0.40, 0.14, 0.065, 1), (0.045, 0.16, 0.065, 1),
              (0.18, 0.31, 0.10, 1)]
    vertices, faces, indices = [], [], []

    def face(points, material):
        start = len(vertices)
        vertices.extend(points)
        faces.append(tuple(range(start, len(vertices))))
        indices.append(material)

    def annulus(cx, cy, inner, outer, bottom, top, material, segments=64):
        for i in range(segments):
            a, b = 2 * math.pi * i / segments, 2 * math.pi * (i + 1) / segments
            def p(r, angle, height):
                return (cx + r * math.cos(angle), cy + r * math.sin(angle), height)
            face([p(inner,a,top),p(outer,a,top),p(outer,b,top),p(inner,b,top)],material)
            face([p(outer,a,bottom),p(outer,b,bottom),p(outer,b,top),p(outer,a,top)],material)
            face([p(inner,b,bottom),p(inner,a,bottom),p(inner,a,top),p(inner,b,top)],material)
            face([p(inner,b,bottom),p(outer,b,bottom),p(outer,a,bottom),p(inner,a,bottom)],material)

    # Real raised bands, rather than coplanar decals. The turquoise is inset
    # between two stone strips, with no overlapping top surfaces.
    for inner, outer, material in [(outer_radius, outer_radius+.17, 0),
                                    (outer_radius+.17, outer_radius+.33, 1),
                                    (outer_radius+.33, outer_radius+.5, 0)]:
        annulus(0,0,inner,outer,z+.9,z+.94,material)

    for i, (cx, cy) in enumerate(planter_positions(outer_radius)):
        # Anchor to the paving, not the translucent water plane 60 cm above it.
        # A 1 cm embed keeps the base in contact despite meshopt quantization.
        annulus(cx,cy,.43,.61,z-.01,z+.63,2,16)
        annulus(cx,cy,.40,.66,z+.63,z+.72,2,16)
        annulus(cx,cy,0,.43,z+.60,z+.63,3,16)
        for stem in range(12):
            a = stem * math.tau / 12 + i*.2
            x, y = cx+.23*math.cos(a), cy+.23*math.sin(a)
            height = z+1.15+.15*(stem%3)
            # Low-poly, solid leaf spears with outward-facing triangles.
            base = [(x+.12*math.cos(a+k*math.tau/4),
                     y+.12*math.sin(a+k*math.tau/4),z+.63) for k in range(4)]
            tip = (x+.18*math.cos(a),y+.18*math.sin(a),height)
            for k in range(4):
                face([base[k],base[(k+1)%4],tip],3+stem%2)

    mesh = bpy.data.meshes.new(NAME)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(NAME, mesh)
    bpy.context.scene.collection.objects.link(obj)
    for i, color in enumerate(colors):
        name = f"{NAME}_{i}"
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.use_backface_culling = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = .42 if i == 1 else .85
        mat.diffuse_color = color
        mesh.materials.append(mat)
    for polygon, index in zip(mesh.polygons, indices):
        polygon.material_index = index
    return obj
