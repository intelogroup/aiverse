// The tile grid shared by split_world.mjs and split_shell.mjs: 3x3-nested squares around the spawn (0,0) over a 486 m root,
// 18 m "fine" cells, plus hero rectangles that override the grid. A tile owns a set of fine cells (or one hero slot).
export const ROOT_HALF = 243, FINE = 18, N = (2 * ROOT_HALF) / FINE; // 27 fine cells per axis
export const makeCellOf = (heroes) => (x, z) => {
  for (let k = 0; k < heroes.length; k++) { const r = heroes[k].rect; if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return N * N + k; }
  const i = Math.min(N - 1, Math.max(0, Math.floor((x + ROOT_HALF) / FINE)));
  const j = Math.min(N - 1, Math.max(0, Math.floor((z + ROOT_HALF) / FINE)));
  return j * N + i;
};
/** Fine cells of a square tile (centre, half) in the grid. */
export const cellsOfSquare = (cx, cz, half) => {
  const i0 = Math.round((cx - half + ROOT_HALF) / FINE), i1 = Math.round((cx + half + ROOT_HALF) / FINE), j0 = Math.round((cz - half + ROOT_HALF) / FINE), j1 = Math.round((cz + half + ROOT_HALF) / FINE);
  const cells = []; for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) cells.push(j * N + i); return cells;
};
/** cell -> index into `layout` (every leaf, empty ones included, so the grid is fully covered). */
export function leafOfCell(layout, heroes) {
  const a = new Int32Array(N * N + heroes.length).fill(-1);
  layout.forEach((t, ti) => { if (t.hero !== undefined) a[N * N + t.hero] = ti; else for (const c of cellsOfSquare(t.cx, t.cz, t.half)) a[c] = ti; });
  return a;
}

/** Replace `prim`'s attributes and indices with the triangles `keep` (triangle numbers), vertices compacted. New accessors, so shared ones stay intact. */
export function subset(doc, prim, keep) {
  const idxAcc = prim.getIndices(); const ia = idxAcc?.getArray(); const vc = prim.getAttribute("POSITION").getCount();
  const remap = new Int32Array(vc).fill(-1); let nv = 0; const order = [];
  const tri = keep.length; const ni = new Uint32Array(tri * 3);
  for (let t = 0; t < tri; t++) for (let k = 0; k < 3; k++) { const v = ia ? ia[keep[t] * 3 + k] : keep[t] * 3 + k; if (remap[v] < 0) { remap[v] = nv++; order.push(v); } ni[t * 3 + k] = remap[v]; }
  for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem), arr = a.getArray(), sz = a.getElementSize(); const out = new arr.constructor(nv * sz);
    for (let i = 0; i < nv; i++) for (let c = 0; c < sz; c++) out[i * sz + c] = arr[order[i] * sz + c];
    prim.setAttribute(sem, doc.createAccessor().setArray(out).setType(a.getType()).setNormalized(a.getNormalized()).setBuffer(a.getBuffer()));
  }
  const idxArr = nv < 65536 ? Uint16Array.from(ni) : ni;
  prim.setIndices(doc.createAccessor().setArray(idxArr).setType("SCALAR").setBuffer(prim.getAttribute("POSITION").getBuffer()));
}
