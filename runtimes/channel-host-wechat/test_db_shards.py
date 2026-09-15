# -*- coding: utf-8 -*-
"""跨分片消息表定位回归测试（适配上游 1.2.2 语义）。

上游 1.2.2 修复：同一会话的 Msg_<md5> 表横跨多个 message_*.db 分片，
旧实现只读第一个命中分片（会丢消息/语音）。现在：
- ``_find_msg_tables`` 返回**全部**命中分片；
- ``_find_msg_table`` 仅作兼容，返回第一个命中分片。
"""

import sqlite3
import unittest

from wechatauto.db import WeChatDB, _md5_hex


class MessageShardSelectionTest(unittest.TestCase):
    def _conns(self, user):
        table = "Msg_" + _md5_hex(user.encode())
        older = sqlite3.connect(":memory:")
        newer = sqlite3.connect(":memory:")
        for conn, sequence in ((older, 100), (newer, 200)):
            conn.execute(f"CREATE TABLE {table} (sort_seq INTEGER)")
            conn.execute(f"INSERT INTO {table} (sort_seq) VALUES (?)", (sequence,))
        return table, older, newer

    def test_find_msg_tables_returns_all_shards(self):
        user = "wxid_test"
        table, older, newer = self._conns(user)
        try:
            db = WeChatDB.__new__(WeChatDB)
            found = db._find_msg_tables(user, [older, newer])

            self.assertEqual(len(found), 2, "跨分片必须全部命中")
            conns = [conn for conn, name in found]
            self.assertIn(older, conns)
            self.assertIn(newer, conns)
            self.assertTrue(all(name == table for _, name in found))
        finally:
            older.close()
            newer.close()

    def test_find_msg_table_keeps_first_match_for_compat(self):
        user = "wxid_test"
        _, older, newer = self._conns(user)
        try:
            db = WeChatDB.__new__(WeChatDB)
            found = db._find_msg_table(user, [older, newer])
            self.assertIsNotNone(found)
            self.assertIs(found[0], older, "兼容接口返回首个命中分片")
        finally:
            older.close()
            newer.close()


if __name__ == "__main__":
    unittest.main()
