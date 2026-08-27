import os
import time
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from .embeddings import classify_topics, embed
from .entities import extract_entities
from .sentiment import classify_sentiment

# root .env, four levels up from this file (workers/classifier/src/classifier/)
load_dotenv(Path(__file__).resolve().parents[4] / ".env")

POLL_INTERVAL_SECONDS = float(os.environ.get("CLASSIFIER_POLL_INTERVAL", "2"))
BATCH_SIZE = int(os.environ.get("CLASSIFIER_BATCH_SIZE", "20"))

# Messages whose rule-tagger already ran synchronously in the gateway
# (source='rule') are "pending" for ML upgrade until a source='ml' row also
# exists for them. This is a poll instead of the plan's Redis Streams queue
# because this dev environment has no Redis (see AIVerse plan Phase 2 notes);
# swap to a stream consumer if push-based dispatch is needed at scale.
PENDING_QUERY = """
    SELECT m.id, m.content
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.is_public = true
      AND NOT EXISTS (
        SELECT 1 FROM message_topics mt
        WHERE mt.message_id = m.id AND mt.source = 'ml'
      )
    ORDER BY m.created_at
    LIMIT %s
"""


def format_vector(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


def process_batch(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(PENDING_QUERY, (BATCH_SIZE,))
        rows = cur.fetchall()

        for message_id, content in rows:
            topics = classify_topics(content)
            for topic, confidence in topics:
                cur.execute(
                    "INSERT INTO message_topics (message_id, topic, confidence, source) "
                    "VALUES (%s, %s, %s, 'ml')",
                    (message_id, topic, round(confidence * 100)),
                )

            label, score = classify_sentiment(content)
            cur.execute(
                "INSERT INTO message_sentiment (message_id, label, score) VALUES (%s, %s, %s) "
                "ON CONFLICT (message_id) DO UPDATE SET label = EXCLUDED.label, score = EXCLUDED.score",
                (message_id, label, score),
            )

            for entity in extract_entities(content):
                cur.execute(
                    "INSERT INTO message_entities (message_id, entity) VALUES (%s, %s)",
                    (message_id, entity),
                )

            vec = embed(content)
            cur.execute(
                "UPDATE messages SET embedding = %s WHERE id = %s",
                (format_vector(vec), message_id),
            )

        conn.commit()
        return len(rows)


def run_forever() -> None:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        print("classifier worker started, polling for public messages pending ML upgrade")
        while True:
            processed = process_batch(conn)
            if processed:
                print(f"processed {processed} message(s)")
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    run_forever()
