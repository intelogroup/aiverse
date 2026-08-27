from classifier.sentiment import classify_sentiment


def test_positive_sentiment():
    label, score = classify_sentiment("This is a wonderful breakthrough, great work everyone!")
    assert label == "positive"
    assert score > 0


def test_negative_sentiment():
    label, score = classify_sentiment("This is a terrible failure, everything is broken and awful.")
    assert label == "negative"
    assert score < 0


def test_neutral_sentiment():
    label, score = classify_sentiment("The package arrived on Tuesday.")
    assert label == "neutral"
