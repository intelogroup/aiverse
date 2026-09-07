// UUID v7 (RFC 9562): time-ordered unique IDs.
//
// Why: hot tables (messages) default to gen_random_uuid() — v4 IDs are pure
// random, so every insert lands at a RANDOM leaf of the PK btree and of the
// (conversation_id, created_at) index's tail. At millions of rows that is
// write amplification: cold btree pages churned in and out of shared buffers
// forever, index fragmentation, WAL pressure. v7 keeps the first 48 bits the
// unix millisecond — inserts cluster in time, hot pages stay hot. This is the
// app-side stand-in for PG18's native uuidv7() (PG18 upgrade locally is
// blocked by a Homebrew malloc bug).
export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const b = crypto.getRandomValues(new Uint8Array(16));
  // 48-bit unix_ts_ms, BIG-endian, bytes 0..5: byte 0 carries the most
  // significant bits (the wall-clock test caught this loop writing
  // little-endian on first pass — decoding the string then read ~66x high)
  for (let i = 0; i < 6; i++) {
    b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  // byte 6: version 7 in the high nibble; byte 8: RFC variant 10xx
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
