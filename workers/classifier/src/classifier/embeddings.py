import numpy as np
from fastembed import TextEmbedding

MODEL_NAME = "BAAI/bge-small-en-v1.5"  # 384-dim, matches messages.embedding column

_model = TextEmbedding(model_name=MODEL_NAME)

# a short natural-language description per taxonomy label gives the
# zero-shot similarity match something more meaningful to compare against
# than the bare label string.
_TOPIC_DESCRIPTIONS: dict[str, str] = {
    "Technology/Coding": "software programming, code, bugs, repositories",
    "Technology/AI": "artificial intelligence, LLMs, agents, model inference",
    "Technology/Robotics": "robots, actuators, servos, robot arm calibration",
    "Economy": "economy, inflation, GDP, recession",
    "Science": "scientific research, experiments, studies, hypotheses",
    "Politics": "elections, senate, congress, government policy",
    "Business": "startups, revenue, markets, customers",
    "Infrastructure/USPS": "USPS postal service, mail delivery, packages",
    "Infrastructure/Internet": "internet service providers, outages, bandwidth, latency",
    "Infrastructure/Energy": "power grid, electricity, solar, batteries",
    "Culture": "movies, music, art, festivals",
    "Crafting": "knitting, woodworking, handmade crafts",
    "Other": "general conversation not covered by another topic",
}

_topic_names = list(_TOPIC_DESCRIPTIONS.keys())
_topic_embeddings = np.array(list(_model.embed(list(_TOPIC_DESCRIPTIONS.values()))))

SIMILARITY_THRESHOLD = 0.55


def embed(text: str) -> list[float]:
    return list(_model.embed([text]))[0].tolist()


def classify_topics(text: str) -> list[tuple[str, float]]:
    """Returns [(topic, confidence_0_to_1), ...] for topics above threshold,
    falling back to [("Other", 1.0)] if nothing clears the bar."""
    vec = np.array(list(_model.embed([text]))[0])
    vec_norm = vec / (np.linalg.norm(vec) or 1.0)
    topic_norms = _topic_embeddings / np.linalg.norm(_topic_embeddings, axis=1, keepdims=True)
    similarities = topic_norms @ vec_norm

    matches = [
        (topic, float(sim))
        for topic, sim in zip(_topic_names, similarities)
        if topic != "Other" and sim >= SIMILARITY_THRESHOLD
    ]
    return matches if matches else [("Other", 1.0)]
