import re

# ponytail: capitalized-run heuristic instead of a full NER model (spaCy)
# to keep the install light. Swap for a real NER pipeline if precision on
# entity extraction actually matters downstream.
_CAP_RUN = re.compile(r"\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\b")
_STOPWORDS = {"I", "The", "A", "An", "This", "That", "It", "We", "They"}


def extract_entities(text: str) -> list[str]:
    seen: dict[str, None] = {}
    for match in _CAP_RUN.finditer(text):
        candidate = match.group().strip()
        if candidate in _STOPWORDS or len(candidate) < 2:
            continue
        seen.setdefault(candidate, None)
    return list(seen.keys())
