import collections
import math
from pathlib import Path
import struct
import tempfile
import unittest
from sacks import sack_mesh
from repair_sacks import repair
from replace_glb_detail import read


def assert_closed(test, vertices, faces):
    edges = collections.Counter(tuple(sorted((f[k],f[(k+1)%3]))) for f in faces for k in range(3))
    test.assertTrue(all(n == 2 for n in edges.values()))
    directed = collections.Counter((f[k],f[(k+1)%3]) for f in faces for k in range(3))
    test.assertTrue(all(directed[(b,a)] == n for (a,b),n in directed.items()))
    volume=0
    for f in faces:
        a,b,c=[vertices[i] for i in f]
        volume += sum(a[i]*(b[(i+1)%3]*c[(i+2)%3]-b[(i+2)%3]*c[(i+1)%3]) for i in range(3))/6
    test.assertGreater(volume, 0)


class SackTests(unittest.TestCase):
    def test_generator_is_closed_and_outward(self):
        for grain in (False,True):
            v,f,_=sack_mesh(grain)
            assert_closed(self,v,f)
            self.assertEqual(min(p[1] for p in v),0)
            self.assertLess(len(f),500)

    def test_shipped_meshes_are_closed(self):
        path=Path(__file__).resolve().parents[2]/'apps/console/public/assets/world-city3.glb'
        doc,data=read(path)
        found=0
        for mesh in doc['meshes']:
            if mesh.get('name') not in ('LIB_goods_g_sack','LIB_goods_g_grainsack'): continue
            found+=1
            self.assertEqual(mesh['extras']['closedSackVersion'],1)
            p=mesh['primitives'][0]; a=doc['accessors'][p['attributes']['POSITION']]; view=doc['bufferViews'][a['bufferView']]
            rows=list(struct.iter_unpack('<fff',data[view['byteOffset']:view['byteOffset']+view['byteLength']]))
            # Weld exported face corners before assessing manifold topology.
            vertices=list(dict.fromkeys(rows)); lookup={p:i for i,p in enumerate(vertices)}
            faces=[tuple(lookup[p] for p in rows[i:i+3]) for i in range(0,len(rows),3)]
            assert_closed(self,vertices,faces)
        self.assertEqual(found,2)
        with tempfile.TemporaryDirectory() as tmp:
            copy=Path(tmp)/'world.glb'; original=path.read_bytes(); copy.write_bytes(original)
            self.assertEqual(repair(copy),[])
            self.assertEqual(copy.read_bytes(),original)

if __name__ == '__main__': unittest.main()
