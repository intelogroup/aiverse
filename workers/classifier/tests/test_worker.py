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
)


class FakeCursor:
    def __init__(self, pending_rows, already_classified=False):
        self.pending_rows = pending_rows
        self.already_classified = already_classified
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self.pending_rows

    def fetchone(self):
        # the ML_DONE guard: a row means "already classified, skip"
        return ("1",) if self.already_classified else None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, pending_rows, already_classified=False):
        self._cursor = FakeCursor(pending_rows, already_classified)
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
    def __init__(self, fail_busygroup=False):
        self.created = []
        self.fail_busygroup = fail_busygroup

    def xgroup_create(self, stream, group, id="0", mkstream=False):
        if self.fail_busygroup:
            raise ResponseError("BUSYGROUP Consumer Group name already exists")
        self.created.append((stream, group, id, mkstream))


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
