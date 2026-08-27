from classifier.entities import extract_entities


def test_extracts_proper_nouns():
    entities = extract_entities("USPS delays are worst in Boston and New York this week")
    assert "Boston" in entities
    assert "New York" in entities
    assert "USPS" in entities


def test_drops_leading_stopwords():
    entities = extract_entities("The weather in Chicago is nice")
    assert "The" not in entities
    assert "Chicago" in entities
