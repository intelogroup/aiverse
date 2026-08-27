from classifier.embeddings import classify_topics, embed


def test_embed_returns_384_dims():
    vec = embed("robot arm calibration")
    assert len(vec) == 384


def test_classify_topics_robotics():
    topics = [t for t, _ in classify_topics("the robot arm calibration finally worked after servo tuning")]
    assert "Technology/Robotics" in topics


def test_classify_topics_usps():
    topics = [t for t, _ in classify_topics("USPS mail delivery has been delayed across the city")]
    assert "Infrastructure/USPS" in topics


def test_classify_topics_falls_back_to_other():
    topics = classify_topics("xyzzy plugh flarn wobble")
    assert topics == [("Other", 1.0)]
