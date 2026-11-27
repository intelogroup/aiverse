"""Add Cipher-compatible facial and upper-neck joints to the world casts.

Run via blender_lock.sh --factory-startup -b --python-exit-code 1 --python
tools/city3/bake_cast_face.py -- source_asset_directory separate_output_directory.
"""
import struct
import sys
from collections import defaultdict
from pathlib import Path

from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake_cast_fingers import append_keys, read_glb, read_keys, write_glb

PREFIX = "mixamorig:"
EXTRAS = ("Neck1", "Jaw", "LeftEye", "RightEye")


def matrix(flat):
    return Matrix([flat[i::4] for i in range(4)])


def flat(matrix):
    return [matrix[row][col] for col in range(4) for row in range(4)]


def skeleton(doc):
    nodes = doc["nodes"]
    names = {n["name"][len(PREFIX):]: i for i, n in enumerate(nodes) if n.get("name", "").startswith(PREFIX)}
    parents = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def local(i):
        n = nodes[i]
        if "matrix" in n:
            return matrix(n["matrix"])
        x, y, z, w = n.get("rotation", (0, 0, 0, 1))
        return Matrix.LocRotScale(n.get("translation",(0,0,0)), Quaternion((w,x,y,z)), n.get("scale",(1,1,1)))

    def world(i):
        return world(parents[i]) @ local(i) if i in parents else local(i)

    return names, world


def raw_rows(doc, binary, index):
    a = doc["accessors"][index]
    view = doc["bufferViews"][a["bufferView"]]
    width = {"SCALAR":1, "VEC3":3, "VEC4":4, "MAT4":16}[a["type"]]
    code = {5121:"B", 5123:"H", 5125:"I", 5126:"f"}[a["componentType"]]
    fmt = "<" + code * width
    base = view.get("byteOffset",0) + a.get("byteOffset",0)
    stride = view.get("byteStride", struct.calcsize(fmt))
    assert "sparse" not in a and view["buffer"] == 0
    return [struct.unpack_from(fmt, binary, base + stride*i) for i in range(a["count"])]


def append_joints(doc, binary, rows):
    idx = len(doc["accessors"])
    view = len(doc["bufferViews"])
    offset = len(binary)
    binary.extend(bytes(joint for row in rows for joint in row))
    doc["bufferViews"].append({"buffer":0, "byteOffset":offset, "byteLength":4*len(rows)})
    doc["accessors"].append({"bufferView":view, "count":len(rows), "componentType":5121, "type":"VEC4"})
    return idx


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x-a)/(b-a)))
    return t*t*(3-2*t)


def visible_eye(positions, indices):
    # Weld UV duplicates for component selection. The iris and visible
    # eyeball are detached islands; the right eye patch belongs to the head.
    points = [tuple(round(v, 5) for v in p) for p in positions]
    adjacent = defaultdict(set)
    for i in range(0, len(indices), 3):
        a,b,c = [points[indices[j][0]] for j in range(i,i+3)]
        for p,q,r in ((a,b,c),(b,a,c),(c,a,b)):
            adjacent[p].update((q,r))
    visited = set()
    eye = set()
    for p in adjacent:
        if p in visited:
            continue
        seen = {p}
        stack = [p]
        while stack:
            n = stack.pop()
            new = adjacent[n] - seen
            seen.update(new)
            stack.extend(new)
        visited.update(seen)
        if (len(seen) > 20 and all(.010 < x < .04 and 1.182 < y < 1.209 and .020 < z < .045
                                   for x,y,z in seen)):
            eye.update(seen)
    assert len(eye) > 500, len(eye)
    return [p in eye for p in points]


def bake(asset, output, donor_doc, donor_binary):
    doc, binary = read_glb(asset)
    names, world = skeleton(doc)
    donor, donor_world = skeleton(donor_doc)
    skin, = doc["skins"]
    nodes = doc["nodes"]
    joints = skin["joints"]
    index = {name: joints.index(node) for name,node in names.items()}
    rest = {name: world(node) for name,node in names.items()}
    inverse = [matrix(row) for row in raw_rows(doc,binary,skin["inverseBindMatrices"])]
    bind = [world(node) @ inv for node,inv in zip(joints,inverse)]
    neck, head = (rest[name].translation for name in ("Neck", "Head"))
    donor_neck, donor_head = (donor_world(donor[name]).translation for name in ("Neck","Head"))
    neck_ratio = (donor_world(donor["Neck1"]).translation-donor_neck).length / (donor_head-donor_neck).length
    split = Vector(nodes[names["Head"]]["translation"]) * neck_ratio
    eve = asset.stem == "cast-eve"
    pivots = {
        "Jaw": Vector((head.x, 1.157 if eve else 1.169, .003 if eve else .037)),
        "LeftEye": Vector((.024, 1.195, .025)),
        "RightEye": Vector((-.024, 1.195, .025)),
    }
    added = {}
    for name in EXTRAS:
        if name in names:
            continue
        parent_name = "Neck" if name == "Neck1" else "Head"
        parent = names[parent_name]
        translation = split if name == "Neck1" else rest[parent_name].inverted() @ pivots[name]
        new_world = rest[parent_name] @ Matrix.Translation(translation)
        node = {"name": PREFIX+name, "translation":list(translation)}
        if name == "Neck1":
            nodes[parent]["children"].remove(names["Head"])
            node["children"] = [names["Head"]]
            nodes[names["Head"]]["translation"] = list(Vector(nodes[names["Head"]]["translation"]) - split)
        nodes[parent].setdefault("children", []).append(len(nodes))
        added[name] = len(nodes)
        index[name] = len(joints)
        joints.append(len(nodes))
        nodes.append(node)
        # Match the source joint's exact neutral skin matrix.
        inverse.append(new_world.inverted() @ bind[index[parent_name]])

    skin["inverseBindMatrices"] = append_keys(doc,binary,[flat(m) for m in inverse],"MAT4")
    counts = defaultdict(int)
    for mesh_id, mesh in enumerate(doc["meshes"]):
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            weights_accessor = doc["accessors"][attrs["WEIGHTS_0"]]
            divisor = 255 if weights_accessor["componentType"] == 5121 else 1
            js = raw_rows(doc,binary,attrs["JOINTS_0"])
            ws = raw_rows(doc,binary,attrs["WEIGHTS_0"])
            points = raw_rows(doc,binary,attrs["POSITION"])
            positions = [bind[j[a]] @ Vector(v) for v,j,w in zip(points,js,ws) for a in [max(range(4),key=w.__getitem__)]]
            eye = visible_eye(positions,raw_rows(doc,binary,primitive["indices"])) if eve else [False]*len(points)
            new_js, new_ws = [], []
            changed = False
            for point, j, w, eyeball in zip(positions,js,ws,eye):
                influences = {bone: amount/divisor for bone,amount in zip(j,w) if amount>0}
                x,y,z = point
                neck_y = neck.y + (head.y-neck.y)*neck_ratio
                neck_weight = .8 * smoothstep(neck.y,neck_y,y) * (1-smoothstep(head.y,head.y+.013,y))
                jaw_low,jaw_high,jaw_back,jaw_front = (1.143,1.159,.009,.033) if eve else (1.153,1.177,.035,.075)
                jaw_weight = .88*(1-smoothstep(jaw_low,jaw_high,y))*smoothstep(jaw_back,jaw_front,z)*(1-smoothstep(.044,.063,abs(x-head.x)))
                jaw_weight *= smoothstep(jaw_low - .030,jaw_low - .012,y)
                transfers = (("Neck1","Neck",neck_weight),("LeftEye","Head",1.0 if eyeball else 0.0),
                             ("Jaw","Head",jaw_weight if not eyeball and (eve or mesh_id == 0) else 0.0))
                for dst,src,fraction in transfers:
                    amount = influences.get(index[src],0)*fraction
                    remaining = influences.get(index[src], 0)-amount
                    # Keep all prior influences. Four occupied slots can only
                    # accept a transfer that consumes the original influence.
                    if amount < .005 or (len(influences) == 4 and remaining > 1e-6):
                        continue
                    if remaining > 1e-6:
                        influences[index[src]] = remaining
                    else:
                        influences.pop(index[src])
                    influences[index[dst]] = amount
                    counts[dst] += 1
                    changed = True
                row = list(influences.items())
                assert len(row) <= 4
                row += [(0,0)] * (4-len(row))
                new_js.append([bone for bone,_ in row])
                new_ws.append([amount for _,amount in row])
            if changed:
                attrs["JOINTS_0"] = append_joints(doc,binary,new_js)
                attrs["WEIGHTS_0"] = append_keys(doc,binary,new_ws,"VEC4")
    assert all(counts[name] > 20 for name in added if name != "RightEye"), counts

    donor_animations = {clip["name"]: clip for clip in donor_doc["animations"]}
    for clip in doc["animations"]:
        donor_clip = donor_animations[clip["name"]]
        donor_tracks = {(c["target"]["node"],c["target"]["path"]):donor_clip["samplers"][c["sampler"]] for c in donor_clip["channels"]}
        duration = max(read_keys(doc,binary,s["input"],1)[-1][0] for s in clip["samplers"])
        for channel in clip["channels"]:
            target = channel["target"]
            if target != {"node":names["Head"],"path":"translation"}:
                continue
            sampler = clip["samplers"][channel["sampler"]].copy()
            rows = read_keys(doc,binary,sampler["output"],3)
            cubic = sampler.get("interpolation") == "CUBICSPLINE"
            output_rows = [row if cubic and i % 3 != 1 else Vector(row)-split
                           for i,row in enumerate(rows)]
            sampler["output"] = append_keys(doc,binary,output_rows,"VEC3")
            channel["sampler"] = len(clip["samplers"])
            clip["samplers"].append(sampler)
        time = append_keys(doc,binary,[(0.0,),(duration,)],"SCALAR")
        for name,new_node in added.items():
            # Donor tracks are neutral. Require explicit authoring for profiles
            # with motion so a moving source cannot silently become neutral.
            src = donor_tracks[donor[name],"rotation"]
            rows = read_keys(donor_doc,donor_binary,src["output"],4)
            assert all(min(max(abs(a-sign*b) for a,b in zip(row,rows[0])) for sign in (1,-1)) < 1e-5 for row in rows)
            rotation = append_keys(doc,binary,[(0.0,0.0,0.0,1.0)]*2,"VEC4")
            clip["channels"].append({"target":{"node":new_node,"path":"rotation"},"sampler":len(clip["samplers"])})
            clip["samplers"].append({"input":time,"output":rotation,"interpolation":"LINEAR"})

    doc["buffers"][0]["byteLength"] = len(binary)
    write_glb(output,doc,binary)
    print(asset.name,len(joints),"skin joints; vertices transferred",dict(counts),flush=True)


if __name__ == "__main__":
    source, output = (Path(p).resolve() for p in sys.argv[sys.argv.index("--")+1:])
    assert source != output
    output.mkdir(parents=True,exist_ok=True)
    donor_doc, donor_binary = read_glb(source/"cast-cipher.glb")
    for name in ("remy","eve"):
        file = f"cast-{name}.glb"
        bake(source/file,output/file,donor_doc,donor_binary)
