from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

_analyzer = SentimentIntensityAnalyzer()


def classify_sentiment(text: str) -> tuple[str, int]:
    """Returns (label, score) where score is the VADER compound score scaled to -100..100."""
    compound = _analyzer.polarity_scores(text)["compound"]
    score = round(compound * 100)
    if compound >= 0.05:
        label = "positive"
    elif compound <= -0.05:
        label = "negative"
    else:
        label = "neutral"
    return label, score
