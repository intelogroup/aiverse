"""Replace only damaged sack primitives; preserve all instance transforms and other assets.
Usage: python3 tools/city3/repair_sacks.py path/to/world.glb [...]
"""
import math
import struct
import sys
from replace_glb_detail import read
from sacks import sack_mesh


def repair(path):
    doc, binary = read(path)
    payload = bytearray(binary)
    found = []
    def attribute(values):
        while len(payload) % 4: payload.append(0)
        offset = len(payload)
        payload.extend(struct.pack('<'+'f'*(len(values)*3), *(v for row in values for v in row)))
        view = len(doc['bufferViews'])
        doc['bufferViews'].append(dict(buffer=0, byteOffset=offset, byteLength=len(values)*12, target=34962))
        accessor = len(doc['accessors'])
        doc['accessors'].append(dict(bufferView=view, componentType=5126, count=len(values), type='VEC3',
            min=[min(row[i] for row in values) for i in range(3)], max=[max(row[i] for row in values) for i in range(3)]))
        return accessor
    for mesh in doc['meshes']:
        name = mesh.get('name','')
        if name not in ('LIB_goods_g_sack','LIB_goods_g_grainsack') or mesh.get('extras',{}).get('closedSackVersion') == 1: continue
        vertices, faces, colors = sack_mesh('grainsack' in name)
        normals = [[0.,0.,0.] for _ in vertices]
        for face in faces:
            a,b,c = [vertices[i] for i in face]
            u=[b[i]-a[i] for i in range(3)]; v=[c[i]-a[i] for i in range(3)]
            normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            for index in face:
                for i in range(3): normals[index][i] += normal[i]
        normals = [tuple(x/(math.sqrt(sum(v*v for v in n)) or 1) for x in n) for n in normals]
        mat = len(doc['materials'])
        doc['materials'].append(dict(name='closed_burlap_sack',pbrMetallicRoughness=dict(baseColorFactor=[1,1,1,1],roughnessFactor=1,metallicFactor=0)))
        mesh['primitives'] = [dict(attributes=dict(
            POSITION=attribute([vertices[i] for face in faces for i in face]),
            NORMAL=attribute([normals[i] for face in faces for i in face]),
            COLOR_0=attribute([colors[k] for k,face in enumerate(faces) for _ in face])),material=mat,mode=4)]
        mesh.setdefault('extras',{})['closedSackVersion']=1
        found.append(name)
    if not found: return []
    doc['buffers'][0]['byteLength'] = len(payload)
    import json
    js=json.dumps(doc,separators=(',',':')).encode(); js+=b' '*((-len(js))%4)
    payload+=b'\0'*((-len(payload))%4)
    data=struct.pack('<4sII',b'glTF',2,28+len(js)+len(payload))+struct.pack('<I4s',len(js),b'JSON')+js+struct.pack('<I4s',len(payload),b'BIN\0')+payload
    from pathlib import Path
    Path(path).write_bytes(data)
    return found

if __name__ == '__main__':
    for path in sys.argv[1:]: print(path, repair(path))
