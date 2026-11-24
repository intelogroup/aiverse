"""Regression check for the Open Day prototype's durable bags."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from store import Store


class BagPersistenceTest(unittest.TestCase):
    def test_inventory_survives_reopen_and_is_keyed_by_agent(self):
        with tempfile.TemporaryDirectory() as temp:
            path = str(Path(temp) / "bags.sqlite")
            egg = {"item": "egg-01", "name": "Egg", "place": "plaza", "t": 1}
            key = {"item": "keycard", "name": "Terminal keycard", "place": "cabin", "t": 2}

            store = Store(path)
            try:
                store.save_bags({"fatima": [egg], "sam": [key]})
            finally:
                store.close()

            reader = """
import json
import sys
from store import Store

store = Store(sys.argv[1])
try:
    print(json.dumps(store.load_bags()))
finally:
    store.close()
"""
            snapshot = subprocess.check_output(
                [sys.executable, "-c", reader, path], cwd=Path(__file__).resolve().parent, text=True
            )
            self.assertEqual(json.loads(snapshot), {"fatima": [egg], "sam": [key]})

            store = Store(path)
            try:
                self.assertEqual(store.bag_of("fatima"), [egg])
                self.assertEqual(store.bag_of("sam"), [key])
                self.assertEqual(store.bag_of("unknown"), [])
                store.save_bags({"fatima": []})
                self.assertEqual(store.bag_of("fatima"), [])
                self.assertEqual(store.bag_of("sam"), [key])
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
