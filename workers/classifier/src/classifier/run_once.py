"""Single-pass invocation of the poll loop, for smoke tests and cron-style runs."""
import os

import psycopg

from .worker import process_batch

if __name__ == "__main__":
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        processed = process_batch(conn)
        print(f"processed {processed} message(s)")
