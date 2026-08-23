import sqlite3
import unittest

from wechatauto.db import WeChatDB, _md5_hex


class MessageShardSelectionTest(unittest.TestCase):
    def test_find_msg_table_selects_shard_with_latest_sort_sequence(self):
        user = "wxid_test"
        table = "Msg_" + _md5_hex(user.encode())
        older = sqlite3.connect(":memory:")
        newer = sqlite3.connect(":memory:")

        try:
            for conn, sequence in ((older, 100), (newer, 200)):
                conn.execute(f"CREATE TABLE {table} (sort_seq INTEGER)")
                conn.execute(f"INSERT INTO {table} (sort_seq) VALUES (?)", (sequence,))

            db = WeChatDB.__new__(WeChatDB)
            found = db._find_msg_table(user, [older, newer])

            self.assertIsNotNone(found)
            self.assertIs(found[0], newer)
        finally:
            older.close()
            newer.close()


if __name__ == "__main__":
    unittest.main()
