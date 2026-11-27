"""Bake the workshop finger rig into cast GLBs without re-exporting the meshes.

Use blender_lock.sh -b --python-exit-code 1 --python bake_cast_fingers.py --
followed by the source asset directory, finger-rigs .blend directory, and a
separate output directory. Only promote the resulting GLBs after verification.
"""
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion

CAST = ("remy", "cipher", "eve")
CLIP = "Texting"
SIDES = ("Left", "Right")
JOINTS = tuple(f"mixamorig:{side}HandPinky{link}" for side in SIDES for link in (1, 2, 3))
# Normalized clip time and additive curl, eased in and out for looping.
CURL = ((0, 0), (0.15, 0), (0.35, 0.28), (0.72, 0.28), (0.9, 0.1), (1, 0))
Y_UP_TO_Z_UP = Quaternion((1, 0, 0), math.pi / 2)


def read_glb(path):
    raw = path.read_bytes()
    magic, version, size, length, kind = struct.unpack_from("<4sIII4s", raw)
    assert (magic, version, size, kind) == (b"glTF", 2, len(raw), b"JSON")
    end = 20 + length
    count, kind = struct.unpack_from("<I4s", raw, end)
    assert kind == b"BIN\0" and end + 8 + count == len(raw)
    return json.loads(raw[20:end]), bytearray(raw[end + 8:])


def write_glb(path, doc, binary):
    header = json.dumps(doc, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    path.write_bytes(
        struct.pack("<4sIII4s", b"glTF", 2, 28 + len(header) + len(binary), len(header), b"JSON")
        + header + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    )


def read_keys(doc, binary, index, width):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    component = accessor["componentType"]
    assert component in (5122, 5126) and "sparse" not in accessor
    code = "h" if component == 5122 else "f"
    fmt = f"<{width}{code}"
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", struct.calcsize(fmt))
    rows = [struct.unpack_from(fmt, binary, offset + index * stride) for index in range(accessor["count"])]
    if component == 5122:
        assert accessor["normalized"]
        return [tuple(max(-1.0, value / 32767) for value in row) for row in rows]
    return rows


def append_keys(doc, binary, rows, kind):
    offset = len(binary)
    for row in rows:
        binary.extend(struct.pack(f"<{len(row)}f", *row))
    view = len(doc["bufferViews"])
    doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset})
    index = len(doc["accessors"])
    accessor = {"bufferView": view, "componentType": 5126, "count": len(rows), "type": kind}
    if kind == "SCALAR":
        accessor.update(min=list(rows[0]), max=list(rows[-1]))
    doc["accessors"].append(accessor)
    return index


def clip_rig():
    rig = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    animation = rig.animation_data
    for track in animation.nla_tracks:
        track.mute = True
    animation.action = bpy.data.actions[CLIP]
    return rig


def set_time(time):
    scene = bpy.context.scene
    frame = time * scene.render.fps / scene.render.fps_base
    scene.frame_set(math.floor(frame), subframe=frame % 1)


def hand_matrices(rig):
    return {bone.name: (rig.matrix_world @ bone.matrix).copy() for bone in rig.pose.bones
            if bone.name.startswith("mixamorig:") and "Hand" in bone.name}


def source_rest_rotations(nodes):
    parents = {child: i for i, node in enumerate(nodes) for child in node.get("children", [])}

    def rotation(index):
        node = nodes[index]
        if "matrix" in node:
            matrix = Matrix([node["matrix"][i::4] for i in range(4)])
            local = matrix.to_quaternion()
        else:
            x, y, z, w = node.get("rotation", (0, 0, 0, 1))
            local = Quaternion((w, x, y, z))
        return (rotation(parents[index]) if index in parents else Y_UP_TO_Z_UP) @ local

    return rotation


def local_rotation(bone):
    return (bone.parent.matrix.inverted() @ bone.matrix).to_quaternion()


def bake(source, workshop, output):
    doc, binary = read_glb(source)
    nodes = doc["nodes"]
    clip = next(clip for clip in doc["animations"] if clip["name"] == CLIP)
    duration = max(read_keys(doc, binary, sample["input"], 1)[-1][0] for sample in clip["samplers"])
    times = [duration * progress for progress, _ in CURL]
    rest_rotation = source_rest_rotations(nodes)
    edits = {}
    bpy.ops.wm.open_mainfile(filepath=str(workshop))
    rig = clip_rig()
    for channel in clip["channels"]:
        target = channel["target"]
        node = target["node"]
        name = nodes[node].get("name")
        if name not in JOINTS or target["path"] != "rotation":
            continue
        sampler = clip["samplers"][channel["sampler"]]
        keys = read_keys(doc, binary, sampler["output"], 4)
        first = keys[0]
        assert all(min(max(abs(a-sign*b) for a,b in zip(first, key)) for sign in (1,-1)) < 0.0001
                   for key in keys), f"{source.name}: {name} already has pinky motion"
        x, y, z, w = first
        bone_rest = (rig.matrix_world @ rig.data.bones[name].matrix_local).to_quaternion()
        correction = rest_rotation(node).inverted() @ bone_rest
        edits[name] = (channel, Quaternion((w, x, y, z)), correction, [])
    assert set(edits) == set(JOINTS)

    expected = []
    for time, (_, curl) in zip(times, CURL):
        set_time(time)
        for side in SIDES:
            rig.pose.bones[f"CTRL_{side}_Pinky"]["Curl"] = 0.0
        rig.update_tag()
        bpy.context.view_layer.update()
        before = hand_matrices(rig)
        local_before = {name: local_rotation(rig.pose.bones[name]) for name in JOINTS}
        for side in SIDES:
            rig.pose.bones[f"CTRL_{side}_Pinky"]["Curl"] = curl * (1 if side == "Right" else 0.8)
        rig.update_tag()
        bpy.context.view_layer.update()
        expected.append((time, before, hand_matrices(rig)))
        for name, (_, source_key, correction, keys) in edits.items():
            delta = local_before[name].inverted() @ local_rotation(rig.pose.bones[name])
            rotation = (source_key @ correction @ delta @ correction.inverted()).normalized()
            x, y, z, w = rotation.x, rotation.y, rotation.z, rotation.w
            keys.append((x, y, z, w))

    time_accessor = append_keys(doc, binary, [(time,) for time in times], "SCALAR")
    for channel, _, _, keys in edits.values():
        # Replace only this channel's sampler. Some source channels share samplers.
        channel["sampler"] = len(clip["samplers"])
        clip["samplers"].append({
            "input": time_accessor,
            "output": append_keys(doc, binary, keys, "VEC4"),
            "interpolation": "LINEAR",
        })
    doc["buffers"][0]["byteLength"] = len(binary)
    write_glb(output, doc, binary)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(output))
    rig = clip_rig()
    peak = 0.0
    for time, before, target in expected:
        set_time(time)
        got = hand_matrices(rig)
        for name, pose in target.items():
            distance = (got[name].translation - pose.translation).length
            angle = got[name].to_quaternion().rotation_difference(pose.to_quaternion()).angle
            assert distance < 0.001 and min(angle, abs(2*math.pi-angle)) < 0.005, (source.name, time, name, distance, angle)
        peak = max(peak, (got["mixamorig:RightHandPinky4"].translation
                          - before["mixamorig:RightHandPinky4"].translation).length)
    assert peak > 0.005
    print(f"PASS {source.name}: six baked joints match Blender; peak right pinky movement {peak*1000:.1f} mm", flush=True)


if __name__ == "__main__":
    assets, workshop, output = [Path(arg).resolve() for arg in sys.argv[sys.argv.index("--") + 1:]]
    assert assets != output
    output.mkdir(parents=True, exist_ok=True)
    for name in CAST:
        filename = f"cast-{name}.glb"
        bake(assets / filename, workshop / f"{name}-finger-controls.blend", output / filename)
