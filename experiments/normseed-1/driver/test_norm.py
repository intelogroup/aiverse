#!/usr/bin/env python3
"""Hand-labeled matcher tests. Each case: (text, speaker_name,
addressed_first_contact, expected_greeting, expected_compliant).
Labels follow DESIGN.md's matcher rules exactly — the mechanical rule
wins over intuition on the odd case (see #19)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from norm import is_compliant

CASES = [
    # --- compliant greetings ---
    ("Tea house — I'm Ruth.", "Ruth", False, True, True),
    ("Bakery! Hi, I'm Emil.", "Emil", False, True, True),
    ("Sage's Library — I'm Cato, keeper of books.", "Cato", False, True, True),
    ("Tea house, hello everyone!", "Ruth", False, True, True),
    ("Good morning! Great Hall — I'm Hugo.", "Hugo", False, True, True),
    ("Well, tea house — I'm Sana.", "Sana", False, True, True),
    ("Shop-102 — I'm Vera.", "Vera", False, True, True),
    ("Stall-40 — I'm Theo.", "Theo", False, True, True),
    ("Bazaar — I'm June.", "June", False, True, True),
    ("Sunstone Bazaar, I'm June.", "June", False, True, True),
    ("Library — Vera here.", "Vera", False, True, True),
    ("Today's Tea — I'm Noor!", "Noor", False, True, True),
    ("The Golden Scale — I'm Emil.", "Emil", False, True, True),
    ("Golden scale, hi, I'm Emil.", "Emil", False, True, True),
    ("Kronikler Press — I'm Sana, I work the presses.", "Sana", False, True, True),
    ("Hello, tea house — I'm Ruth.", "Ruth", False, True, True),
    ("Oh! Tea house — I'm June.", "June", False, True, True),
    ("Coffee's on me — I'm Alba.", "Alba", False, True, True),  # rule-faithful
    ("Tea house?", "Ruth", True, True, True),  # addressed, place leads
    # --- greetings, NOT compliant ---
    ("I'm Ruth.", "Ruth", False, True, False),
    ("Hello! I'm Ruth, nice to meet you.", "Ruth", False, True, False),
    ("I'm Emil — bakery side.", "Emil", False, True, False),
    ("Hello from the tea house! I'm Noor.", "Noor", False, True, False),
    ("Welcome to the bakery, I'm Mina.", "Mina", False, True, False),
    ("I'm at the tea house, I'm Vera.", "Vera", False, True, False),
    ("Hi Theo!", "June", True, True, False),
    ("Hey everyone, I'm Ruth from the tea house.", "Ruth", False, True, False),
    ("Greetings from Sage's Library. I'm Vera.", "Vera", False, True, False),
    ("My name is Hugo — great hall is grand.", "Hugo", False, True, False),
    ("I'm Emil, from the Golden Scale.", "Emil", False, True, False),
    ("Nice to meet you! I'm Ruth.", "Ruth", False, True, False),
    ("I love this tea house. I'm Alba.", "Alba", False, True, False),
    # --- not greetings at all ---
    ("The tea house is lovely today.", "Alba", False, False, False),
    ("Tea house?", "Ruth", False, False, False),
    ("Has anyone seen the bakery?", "Emil", False, False, False),
]

def main():
    fails = 0
    for i, (text, name, afc, eg, ec) in enumerate(CASES, 1):
        r = is_compliant(text, name, afc)
        ok = (r["greeting"] == eg and r["compliant"] == ec)
        if not ok:
            fails += 1
            print(f"FAIL #{i}: {text!r} name={name} afc={afc} -> "
                  f"greeting={r['greeting']} (want {eg}), "
                  f"compliant={r['compliant']} (want {ec}), {r}")
    print(f"{len(CASES) - fails}/{len(CASES)} hand-labeled cases pass")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
