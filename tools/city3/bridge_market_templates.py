"""Apply approved produce/vase templates without touching other City3 assets or placements."""
import argparse
import json
from pathlib import Path
import struct
from replace_glb_detail import read, replace


def bridge(base, kit, output):
    old, prefix = read(base)
    replace(base, kit, output)
    doc, binary = read(output)
    replacements = {n['name']: n['mesh'] for n in doc['nodes'][len(old['nodes']):] if 'mesh' in n}
    changed = []
    for i, before in enumerate(old['nodes']):
        if before.get('name') in replacements:
            doc['nodes'][i]['mesh'] = replacements[before['name']]
            changed.append(before['name'])
        restored = dict(doc['nodes'][i]); restored['mesh'] = before['mesh'] if 'mesh' in before else restored.get('mesh')
        if 'mesh' not in before: restored.pop('mesh', None)
        assert restored == before
    assert set(changed) == set(replacements)
    for scene in doc['scenes']:
        scene['nodes'] = [i for i in scene.get('nodes', []) if doc['nodes'][i].get('name') != 'City3GoodsTemplates']
    assert binary[:len(prefix)] == prefix
    header = json.dumps(doc,separators=(',',':')).encode(); header += b' '*(-len(header)%4)
    Path(output).write_bytes(struct.pack('<III',0x46546c67,2,28+len(header)+len(binary))+struct.pack('<II',len(header),0x4e4f534a)+header+struct.pack('<II',len(binary),0x004e4942)+binary)
    print('Updated',len(changed),'templates; instance transforms and original data preserved.')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base',type=Path); parser.add_argument('output',type=Path)
    parser.add_argument('--kit',type=Path,default=Path(__file__).resolve().parent/'assets/market_realism/fruit-vases.glb')
    args=parser.parse_args(); bridge(args.base,args.kit,args.output)
