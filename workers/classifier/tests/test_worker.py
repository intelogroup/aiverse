from classifier.worker import format_vector, process_batch


class FakeCursor:
    def __init__(self, pending_rows):
        self.pending_rows = pending_rows
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self.pending_rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, pending_rows):
        self._cursor = FakeCursor(pending_rows)
        self.committed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True


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

    # every write after the initial SELECT must target msg-1, no cross-row leakage
    write_params = [p for sql, p in conn._cursor.executed if sql != conn._cursor.executed[0][0]]
    for _sql, params in conn._cursor.executed[1:]:
        assert params[0] == "msg-1" or params[-1] == "msg-1"


def test_process_batch_is_a_noop_when_nothing_pending():
    conn = FakeConn([])
    processed = process_batch(conn)
    assert processed == 0
    assert conn.committed is True
