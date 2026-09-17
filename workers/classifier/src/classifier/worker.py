import logging
import os
from pathlib import Path

import psycopg
import redis
from dotenv import load_dotenv

from .embeddings import classify_topics, embed
from .entities import extract_entities
from .sentiment import classify_sentiment

# root .env, four levels up from this file (workers/classifier/src/classifier/)
load_dotenv(Path(__file__).resolve().parents[4] / ".env")

log = logging.getLogger("classifier")

BATCH_SIZE = int(os.environ.get("CLASSIFIER_BATCH_SIZE", "20"))
BLOCK_MS = int(os.environ.get("CLASSIFIER_BLOCK_MS", "5000"))

# Feed written by the gateway's ingest consumer (item 1): every public
# message persisted from the verse:ingest stream is XADDed here with its
# content, so the classifier never polls Postgres on its hot path.
CLASSIFY_STREAM = "verse:classify"
CLASSIFY_GROUP = "classify-consumers"
# Stable across restarts (not pid-based): on boot we re-read our own pending
# entries first, so a crash between processing and XACK replays instead of
# orphaning. Override per-replica if you ever scale past one worker.
CLASSIFY_CONSUMER = os.environ.get("CLASSIFIER_CONSUMER", "classifier")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

# Messages whose rule-tagger already ran in the gateway (source='rule') are
# "pending" for ML upgrade until a source='ml' row also exists for them.
# Still used by process_batch: the startup catch-up for pre-stream messages
# and run_once.py's cron-style single pass.
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

# Dedupe guard: the stream is at-least-once (replays after a crash between
# the gateway's Postgres commit and XACK, XAUTOCLAIM races), so a feed entry
# may arrive twice. Skip anything already classified — mirrors the
# PENDING_QUERY's "until a source='ml' row exists" semantics per message.
ML_DONE_QUERY = "SELECT 1 FROM message_topics WHERE message_id = %s AND source = 'ml' LIMIT 1"


def format_vector(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


def process_message(cur: psycopg.Cursor, message_id: str, content: str) -> bool:
    """ML-upgrade one message. Returns True when it wrote rows, False when
    the message was already classified (duplicate feed delivery)."""
    cur.execute(ML_DONE_QUERY, (message_id,))
    if cur.fetchone():
        return False

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
    return True


def process_batch(conn: psycopg.Connection) -> int:
    """Poll-based single pass over public messages pending ML upgrade.
    Kept for run_once.py (cron-style runs) and the startup catch-up below;
    the steady state is the stream consumer in consume_forever."""
    with conn.cursor() as cur:
        cur.execute(PENDING_QUERY, (BATCH_SIZE,))
        rows = cur.fetchall()

        processed = 0
        for message_id, content in rows:
            if process_message(cur, message_id, content):
                processed += 1

        conn.commit()
        return processed


def parse_stream_entry(fields: dict) -> tuple[str, str] | None:
    """Pull (message_id, content) out of a verse:classify entry. The gateway
    XADDs messageId/content as plain strings; returns None for malformed
    entries so the consumer can ack-and-skip the poison instead of stalling."""

    def get(key: str) -> str | None:
        v = fields.get(key, fields.get(key.encode()))
        if v is None:
            return None
        return v.decode() if isinstance(v, bytes) else v

    message_id = get("messageId")
    content = get("content")
    if not message_id or content is None:
        return None
    return message_id, content


def ensure_group(r: redis.Redis) -> None:
    # id "0", not "$": a group created after entries were published must
    # still see them (same rationale as the gateway's ingest group).
    try:
        r.xgroup_create(CLASSIFY_STREAM, CLASSIFY_GROUP, id="0", mkstream=True)
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def consume_once(conn: psycopg.Connection, r: redis.Redis, read_id: str) -> bool:
    """One XREADGROUP round-trip: process a batch, ack it. Returns True when
    any entries were read (False = idle timeout, caller decides what next)."""
    resp = r.xreadgroup(CLASSIFY_GROUP, CLASSIFY_CONSUMER, {CLASSIFY_STREAM: read_id}, count=BATCH_SIZE, block=BLOCK_MS)
    if not resp:
        return False
    for _stream, entries in resp:
        ack_ids = []
        with conn.cursor() as cur:
            for entry_id, fields in entries:
                parsed = parse_stream_entry(fields)
                if parsed is None:
                    log.warning("skipping malformed classify entry %s", entry_id)
                    ack_ids.append(entry_id)
                    continue
                message_id, content = parsed
                if process_message(cur, message_id, content):
                    log.debug("classified %s", message_id)
                ack_ids.append(entry_id)
            conn.commit()
        if ack_ids:
            r.xack(CLASSIFY_STREAM, CLASSIFY_GROUP, *ack_ids)
    return True


def consume_forever(conn: psycopg.Connection, r: redis.Redis) -> None:
    """Stream-first main loop. The pending re-read ("0") replays entries a
    previous run of this consumer read but never acked (crash between
    processing and XACK); then ">" takes over for new entries."""
    ensure_group(r)
    log.info("classifier consuming stream %s as %s/%s", CLASSIFY_STREAM, CLASSIFY_GROUP, CLASSIFY_CONSUMER)
    # Drain own pending first (bounded: stops at the first idle timeout),
    # then live-tail forever.
    while consume_once(conn, r, "0"):
        pass
    while True:
        consume_once(conn, r, ">")


def make_redis_client() -> redis.Redis:
    # redis-py's default socket_timeout is 5s; it must outlive the server-side
    # BLOCK, otherwise every idle block window raises TimeoutError and the
    # worker crash-loops. +10s headroom covers scheduling jitter.
    return redis.Redis.from_url(REDIS_URL, socket_timeout=BLOCK_MS / 1000 + 10)


def run_forever() -> None:
    logging.basicConfig(level=os.environ.get("CLASSIFIER_LOG_LEVEL", "INFO"))
    database_url = os.environ["DATABASE_URL"]
    r = make_redis_client()
    with psycopg.connect(database_url) as conn:
        # Catch-up: anything public that never got ML rows before the stream
        # existed (pre-item-1 messages, direct DB inserts) still needs them.
        # Bounded loop, not infinite — the stream takes over after.
        while True:
            processed = process_batch(conn)
            if not processed:
                break
            print(f"catch-up processed {processed} message(s)")
        print("classifier worker started, consuming verse:classify stream")
        consume_forever(conn, r)


if __name__ == "__main__":
    run_forever()
