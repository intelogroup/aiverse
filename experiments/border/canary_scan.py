#!/usr/bin/env python3
"""CANARY SCANNER — the border's grep, with normalizations.

Scans files (bytes) for every registered canary needle. Matching is
case-insensitive on the raw bytes, plus a digits-only pass so a phone
number reformatted as 614-555-0187 or 614.555.0187 still trips the
phone canary. Returns structured hits: {file, canary, needle, offset}.

Used by: the package static test (L1), the adversarial probe (L6,
scanning the envoy's speech), and the return-path scan (L5). A scanner
that has never caught anything is unproven — every layer that uses it
also runs a planted-canary positive control.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from canaries import CANARIES, needles  # noqa: E402


def _digits(b: bytes) -> bytes:
    return bytes(c for c in b if 48 <= c <= 57)


def scan_bytes(data: bytes, label: str):
    """All canary hits in one byte blob."""
    hits = []
    low = data.lower()
    digits = _digits(data)
    for cid in CANARIES:
        for n in needles(cid):
            nb = n.lower().encode()
            off = low.find(nb)
            if off >= 0:
                hits.append({"file": label, "canary": cid,
                             "needle": n, "offset": off,
                             "match": "raw"})
        # digits-only pass: only meaningful for the phone canary
        if cid == "phone":
            dn = _digits(CANARIES["phone"]["value"].encode())
            off = digits.find(dn)
            if off >= 0 and not any(h["canary"] == "phone" for h in hits):
                hits.append({"file": label, "canary": "phone",
                             "needle": "(digits-normalized)",
                             "offset": off, "match": "digits"})
    return hits


def scan_file(path: Path):
    try:
        data = path.read_bytes()
    except OSError as e:
        return [{"file": str(path), "canary": None, "needle": None,
                 "offset": -1, "match": f"unreadable: {e}"}]
    return scan_bytes(data, str(path))


def scan_tree(root: Path, skip_suffixes=()):
    """Scan every file under root. Returns (hits, files_scanned)."""
    hits, n = [], 0
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.suffix in skip_suffixes:
            continue
        n += 1
        hits.extend(scan_file(f))
    return hits, n


def scan_text(text: str, label: str):
    return scan_bytes(text.encode("utf-8", "replace"), label)


if __name__ == "__main__":
    root = Path(sys.argv[1])
    hits, n = scan_tree(root)
    print(f"scanned {n} files under {root}: {len(hits)} hit(s)")
    for h in hits:
        print(f"  [{h['canary']}] {h['file']} @{h['offset']} "
              f"needle={h['needle']!r} ({h['match']})")
    sys.exit(1 if hits else 0)
