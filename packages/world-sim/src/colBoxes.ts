// colBoxes.ts — the furniture-collision sidecar of a room layout (public/assets/interiors/<id>.col.json). Pure: shared by the console's
// room streamer and the server sim's headless loader.

/** Sidecar of a layout URL: `/assets/interiors/<id>.json` -> `/assets/interiors/<id>.col.json` (furniture boxes). */
export function colUrl(layoutUrl: string): string {
  return layoutUrl.replace(/\.json$/, ".col.json");
}

/** One furniture box: [cx, cz, hx, hz, y0, y1, rotY] in the same three space as the layout (before any room shift). */
export type ColBoxTuple = [number, number, number, number, number, number, number];

/** Accepts `[[...], ...]` or `{boxes: [[...], ...]}`; drops malformed / degenerate entries. */
export function parseColBoxes(json: unknown): ColBoxTuple[] {
  const raw = Array.isArray(json) ? json : (json as { boxes?: unknown } | null)?.boxes;
  if (!Array.isArray(raw)) return [];
  const out: ColBoxTuple[] = [];
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 6 || !b.slice(0, 7).every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const [cx, cz, hx, hz, y0, y1, rot = 0] = b as number[];
    if (hx <= 0 || hz <= 0 || y1 <= y0) continue;
    out.push([cx, cz, hx, hz, y0, y1, rot]);
  }
  return out;
}
