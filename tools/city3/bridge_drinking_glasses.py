"""Redirect only the existing drinking-glass meshes; all placements and legacy bytes survive."""
import argparse
import copy
import json
from pathlib import Path
import struct

from replace_glb_detail import read, replace


def bridge(base, kit, output, target):
    original, prefix = read(base)
    replace(base, kit, output)
    doc, payload = read(output)
    appended = doc['nodes'][len(original['nodes']):]
    replacement = next(n['mesh'] for n in appended if n.get('name') == target and 'mesh' in n)
    changed = 0
    for i, node in enumerate(original['nodes']):
        if node.get('name') == target and 'mesh' in node:
            doc['nodes'][i]['mesh'] = replacement
            restored = copy.deepcopy(doc['nodes'][i]); restored['mesh'] = node['mesh']
            assert restored == node, 'Placement/instancing metadata changed'
            changed += 1
        else:
            assert doc['nodes'][i] == node
    assert changed, f'Missing target {target}'
    for scene in doc['scenes']:
        scene['nodes'] = [i for i in scene.get('nodes',[]) if doc['nodes'][i].get('name') != 'DrinkwareTemplates']
    assert payload[:len(prefix)] == prefix
    header = json.dumps(doc, separators=(',',':')).encode(); header += b' '*(-len(header)%4)
    output = Path(output)
    output.write_bytes(struct.pack('<III',0x46546c67,2,28+len(header)+len(payload))+struct.pack('<II',len(header),0x4e4f534a)+header+struct.pack('<II',len(payload),0x004e4942)+payload)
    print(f'Redirected {changed} {target} mesh; all instance transforms and legacy bytes preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base',type=Path); parser.add_argument('output',type=Path)
    parser.add_argument('--kit',type=Path,default=Path(__file__).resolve().parent/'assets/verres/drinkware.glb')
    parser.add_argument('--target',required=True,choices=['inst_goods_goblets','LIB_brass_goblets'])
    args=parser.parse_args()
    bridge(args.base,args.kit,args.output,args.target)
