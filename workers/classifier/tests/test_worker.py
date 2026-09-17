import pytest
from redis.exceptions import ResponseError

from classifier.worker import (
    BLOCK_MS,
    CLASSIFY_GROUP,
    CLASSIFY_STREAM,
    ensure_group,
    format_vector,
    make_redis_client,
    parse_stream_entry,
    process_batch,
    process_message,
    reclaim_stale,
)


class FakeCursor:
    def __init__(self, pending_rows, already_classified=False, message_exists=True):
        self.pending_rows = pending_rows
        self.already_classified = already_classified
        self.message_exists = message_exists
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self.pending_rows

    def fetchone(self):
        sql, _params = self.executed[-1]
        if "FROM messages WHERE id" in sql:
            # the poison guard: a row means "message really persisted"
            return ("1",) if self.message_exists else None
        # the ML_DONE guard: a row means "already classified, skip"
        return ("1",) if self.already_classified else None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, pending_rows, already_classified=False, message_exists=True):
        self._cursor = FakeCursor(pending_rows, already_classified, message_exists)
        self.committed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True


def write_statements(cursor):
    """Non-SELECT statements only — the poll SELECT and the ml-done guard
    SELECT are reads, not per-message writes."""
    return [(sql, params) for sql, params in cursor.executed if not sql.lstrip().upper().startswith("SELECT")]


def test_format_vector_matches_pgvector_literal_syntax():
    assert format_vector([1.0, -0.5, 0.0]) == "[1.00000000,-0.50000000,0.00000000]"


def test_process_batch_writes_topics_sentiment_entities_and_embedding_per_row():
    conn = FakeConn([("msg-1", "the robot arm calibration finally worked")])

    processed = process_batch(conn)

    assert processed == 1
    assert conn.committed is True

    sql_texts = [sql for sql, _params in conn._cursor.executed]
    assert any("INSERT INTO message_topics" in s for s in sql_texts)
    assert any("INSERT INTO message_sentiment" in s for s in sql_texts)
    assert any("UPDATE messages SET embedding" in s for s in sql_texts)

    # every write must target msg-1, no cross-row leakage
    for _sql, params in write_statements(conn._cursor):
        assert params[0] == "msg-1" or params[-1] == "msg-1"


def test_process_batch_is_a_noop_when_nothing_pending():
    conn = FakeConn([])
    processed = process_batch(conn)
    assert processed == 0
    assert conn.committed is True


def test_process_message_skips_already_classified_rows():
    """Dedupe guard: a redelivered stream entry must not write twice."""
    conn = FakeConn([], already_classified=True)
    with conn.cursor() as cur:
        assert process_message(cur, "msg-9", "hello again") is False
    assert write_statements(conn._cursor) == []


def test_process_message_returns_true_and_writes_when_new():
    conn = FakeConn([])
    with conn.cursor() as cur:
        assert process_message(cur, "msg-2", "the robot arm calibration finally worked") is True
    assert len(write_statements(conn._cursor)) > 0


def test_process_message_skips_unknown_message_without_writes():
    """Poison guard: a classify entry for a message id Postgres never
    persisted (a clientMessageId-conflict loser) must be skipped, not
    FK-violate the message_topics/message_sentiment/message_entities
    INSERTs and wedge the batch."""
    conn = FakeConn([], message_exists=False)
    with conn.cursor() as cur:
        assert process_message(cur, "phantom-id", "hello") is False
    assert write_statements(conn._cursor) == []


def test_parse_stream_entry_decodes_bytes_fields():
    assert parse_stream_entry({b"messageId": b"abc", b"content": b"hello"}) == ("abc", "hello")


def test_parse_stream_entry_accepts_str_fields():
    assert parse_stream_entry({"messageId": "abc", "content": "hello"}) == ("abc", "hello")


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {b"content": b"no id"},
        {b"messageId": b"no content"},
    ],
)
def test_parse_stream_entry_rejects_malformed(fields):
    assert parse_stream_entry(fields) is None


class FakeRedis:
    def __init__(self, fail_busygroup=False, autoclaim_batches=None):
        self.created = []
        self.fail_busygroup = fail_busygroup
        self.autoclaim_batches = list(autoclaim_batches or [])
        self.acked = []

    def xgroup_create(self, stream, group, id="0", mkstream=False):
        if self.fail_busygroup:
            raise ResponseError("BUSYGROUP Consumer Group name already exists")
        self.created.append((stream, group, id, mkstream))

    def xautoclaim(self, stream, group, consumer, min_idle, start_id="0-0", count=None):
        if not self.autoclaim_batches:
            return (b"0-0", [])
        return self.autoclaim_batches.pop(0)

    def xack(self, stream, group, *ids):
        self.acked.extend(ids)


def test_ensure_group_creates_at_zero_with_mkstream():
    r = FakeRedis()
    ensure_group(r)
    assert r.created == [(CLASSIFY_STREAM, CLASSIFY_GROUP, "0", True)]


def test_ensure_group_tolerates_busygroup():
    r = FakeRedis(fail_busygroup=True)
    ensure_group(r)  # must not raise


def test_redis_client_socket_timeout_outlives_block():
    """Regression: redis-py's 5s default socket_timeout must not abort the
    server-side BLOCK — the worker would crash-loop on every idle window."""
    r = make_redis_client()
    try:
        kwargs = r.connection_pool.connection_kwargs
        assert kwargs.get("socket_timeout", 0) > BLOCK_MS / 1000
    finally:
        r.close()


def test_reclaim_stale_processes_and_acks_stranded_entries():
    """Entries stranded by a dead/renamed consumer are autoclaimed, classified,
    and acked instead of sitting in the PEL forever."""
    conn = FakeConn([])
    stranded = [(b"1-0", {b"messageId": b"msg-r1", b"content": b"hello world"})]
    r = FakeRedis(autoclaim_batches=[(b"0-0", stranded)])

    assert reclaim_stale(conn, r) == 1
    assert r.acked == [b"1-0"]
    assert conn.committed is True
    assert any("INSERT INTO message_topics" in sql for sql, _ in conn._cursor.executed)


def test_reclaim_stale_returns_zero_when_nothing_stranded():
    conn = FakeConn([])
    r = FakeRedis()

    assert reclaim_stale(conn, r) == 0
    assert r.acked == []
    assert conn.committed is False
