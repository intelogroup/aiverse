"""Replace one scene-root detail without round-tripping the legacy city's meshes.

Usage: python3 replace_glb_detail.py base.glb detail.glb output.glb
The detail must have one named root. Old detail data remains unreferenced so
all unrelated accessors, meshes, textures and compressed bytes stay untouched.
Always use the saved pre-edit GLB as base when iterating, to avoid payload growth.
"""
import copy
import json
from pathlib import Path
import struct
import sys


def read(path):
    data = Path(path).read_bytes()
    assert data[:4] == b"glTF" and struct.unpack_from("<II", data, 4) == (2, len(data))
    size, kind = struct.unpack_from("<II", data, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(data[20:20+size])
    offset = 20+size
    length, kind = struct.unpack_from("<II", data, offset)
    assert kind == 0x004E4942 and offset+8+length == len(data)
    return doc, data[offset+8:]


def replace(base, detail, output):
    doc, binary = read(base)
    add, payload = read(detail)
    original = copy.deepcopy(doc)
    assert len(add['buffers']) == 1 and not add.get('animations') and not add.get('skins')
    assert not add.get('extensions')
    roots = add['scenes'][add.get('scene', 0)]['nodes']
    assert len(roots) == 1
    name = add['nodes'][roots[0]]['name']
    # The generated garden is a scene root, never an interior/library child.
    old = {i for i, n in enumerate(doc['nodes']) if n.get('name') == name}
    assert not any(old.intersection(n.get('children', [])) for n in doc['nodes'])
    for scene in doc['scenes']:
        scene['nodes'] = [i for i in scene.get('nodes', []) if i not in old]
    keys = ('bufferViews', 'accessors', 'images', 'samplers', 'textures', 'materials', 'meshes', 'nodes')
    offsets = {k: len(doc.get(k, [])) for k in keys}
    for view in add.get('bufferViews', []):
        assert not view.get('extensions'), 'Compressed detail is not supported'
        view['buffer'] = 0
        view['byteOffset'] = view.get('byteOffset', 0)+len(binary)
    for accessor in add.get('accessors', []):
        assert not accessor.get('sparse')
        if 'bufferView' in accessor:
            accessor['bufferView'] += offsets['bufferViews']
    for img in add.get('images', []):
        assert 'bufferView' in img and 'uri' not in img
        img['bufferView'] += offsets['bufferViews']
    for tex in add.get('textures', []):
        assert not tex.get('extensions')
        tex['source'] += offsets['images']
        if 'sampler' in tex:
            tex['sampler'] += offsets['samplers']

    def textures(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith('Texture') and isinstance(child, dict) and 'index' in child:
                    child['index'] += offsets['textures']
                else:
                    textures(child)
        elif isinstance(value, list):
            for child in value:
                textures(child)

    for mat in add.get('materials', []):
        textures(mat)
    for mesh in add['meshes']:
        for primitive in mesh['primitives']:
            assert not primitive.get('extensions') and not primitive.get('targets')
            primitive['attributes'] = {k: v+offsets['accessors'] for k, v in primitive['attributes'].items()}
            for key, table in (('indices', 'accessors'), ('material', 'materials')):
                if key in primitive:
                    primitive[key] += offsets[table]
    for node in add['nodes']:
        assert not node.get('extensions') and 'skin' not in node and 'camera' not in node
        if 'mesh' in node:
            node['mesh'] += offsets['meshes']
        if 'children' in node:
            node['children'] = [i+offsets['nodes'] for i in node['children']]
    for key in keys:
        doc.setdefault(key, []).extend(add.get(key, []))
    doc['scenes'][doc.get('scene', 0)]['nodes'].extend(i+offsets['nodes'] for i in roots)
    for key in ('extensionsUsed', 'extensionsRequired'):
        for ext in add.get(key, []):
            if ext not in doc.setdefault(key, []):
                doc[key].append(ext)
    for key in keys:
        assert doc[key][:len(original.get(key, []))] == original.get(key, []), key
    data = binary+payload
    doc['buffers'][0]['byteLength'] = len(data)
    header = json.dumps(doc, separators=(',', ':')).encode()
    header += b' '*(-len(header) % 4)
    data += b'\0'*(-len(data) % 4)
    result = struct.pack('<III', 0x46546C67, 2, 28+len(header)+len(data))
    result += struct.pack('<II', len(header), 0x4E4F534A)+header
    result += struct.pack('<II', len(data), 0x004E4942)+data
    Path(output).write_bytes(result)
    print(f'Replaced {name}; {len(old)} prior roots detached; {len(result):,} bytes. Legacy binary preserved.')


if __name__ == '__main__':
    replace(*sys.argv[1:])
