"""v1.1.3 回归测试：WAL 合并后坏缓存死循环修复。

背景：旧 `_check_merged` 只查 `sqlite_master`（schema 树），数据页损坏仍能通过
校验，坏缓存被 stamp 标为「最新」后被轮询复用，反复抛
``database disk image is malformed`` 形成死循环。
"""

import os
import sqlite3
import tempfile
import unittest

from wechatauto.db import WeChatDB


def _build_db(path: str) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        conn.execute("INSERT INTO t (v) VALUES ('hello')")
        conn.commit()
    finally:
        conn.close()


def _corrupt_data_pages(path: str) -> None:
    """把 schema 页（页1）之外的数据页整个填零——模拟 WAL 合并坏页后的缓存。

    页1 完好时 `SELECT count(*) FROM sqlite_master` 依旧可用，
    但读取数据表会抛 database disk image is malformed。
    """
    size = os.path.getsize(path)
    page_sz = 4096
    pages = (size + page_sz - 1) // page_sz
    with open(path, "r+b") as f:
        for pgno in range(2, pages + 1):
            f.seek((pgno - 1) * page_sz)
            f.write(b"\x00" * page_sz)


class _FakeRow:
    def __init__(self, mapping):
        self._m = mapping

    def __getitem__(self, key):
        return self._m[key]


class _FlakyMsgConnDb(WeChatDB):
    """用可编程的 _msg_conn 替身驱动 _run_msg_query 的重试语义。"""

    def __init__(self, conns_per_call, invalidate_log):
        # 不调用父类 __init__：无需真实微信数据目录
        self._conns_per_call = list(conns_per_call)
        self.invalidate_log = invalidate_log
        self.workdir = "<workdir>"

    def _msg_conn(self, user):
        if not self._conns_per_call:
            return None
        item = self._conns_per_call.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def _message_dbs(self):
        return [os.path.join("message", "message_1.db")]

    def _invalidate_cache(self, dst):
        self.invalidate_log.append(dst)


class CheckMergedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dst = os.path.join(self.tmp.name, "message__message_1.db")
        _build_db(self.dst)

    def test_healthy_db_passes_quick_check(self):
        self.assertTrue(WeChatDB._check_merged(self.dst))

    def test_corrupted_data_pages_fail_quick_check(self):
        _corrupt_data_pages(self.dst)
        self.assertFalse(WeChatDB._check_merged(self.dst))

    def test_invalidated_cache_removes_db_and_stamp(self):
        stamp = self.dst + ".stamp"
        with open(stamp, "w") as f:
            f.write("2,0,0,0,0,0")
        WeChatDB._invalidate_cache(self.dst)
        self.assertFalse(os.path.exists(self.dst))
        self.assertFalse(os.path.exists(stamp))

    def test_invalidate_cache_tolerates_missing_files(self):
        WeChatDB._invalidate_cache(os.path.join(self.tmp.name, "absent.db"))


class RunMsgQueryRecoveryTest(unittest.TestCase):
    @staticmethod
    def _healthy_conn():
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE Msg_x (local_id INTEGER, local_type INTEGER, "
            "real_sender_id TEXT, create_time INTEGER, message_content TEXT, "
            "sort_seq INTEGER)"
        )
        conn.execute(
            "INSERT INTO Msg_x VALUES (7, 1, 'wxid_a', 100, 'hi', 11)"
        )
        conn.commit()
        return conn, "Msg_x"

    def test_malformed_cache_is_invalidated_and_retried(self):
        good = self._healthy_conn()
        invalidate_log = []
        db = _FlakyMsgConnDb(
            [
                sqlite3.DatabaseError("database disk image is malformed"),
                good,
            ],
            invalidate_log,
        )
        rows = db._run_msg_query(
            "wxid_a",
            lambda conn, table: conn.execute(
                "SELECT * FROM %s" % table
            ).fetchall(),
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["local_id"], 7)
        self.assertEqual(rows[0]["content"], "hi")
        self.assertEqual(
            invalidate_log,
            ["<workdir>\\message__message_1.db"],
        )
        good[0].close()

    def test_non_malformed_database_error_raises_immediately(self):
        invalidate_log = []
        db = _FlakyMsgConnDb(
            [sqlite3.DatabaseError("no such table: Msg_x")],
            invalidate_log,
        )
        with self.assertRaises(sqlite3.DatabaseError):
            db._run_msg_query(
                "wxid_a", lambda conn, table: conn.execute("SELECT 1").fetchall()
            )
        self.assertEqual(invalidate_log, [])

    def test_malformed_error_second_time_raises(self):
        invalidate_log = []
        db = _FlakyMsgConnDb(
            [
                sqlite3.DatabaseError("database disk image is malformed"),
                sqlite3.DatabaseError("database disk image is malformed"),
            ],
            invalidate_log,
        )
        with self.assertRaises(sqlite3.DatabaseError):
            db._run_msg_query(
                "wxid_a", lambda conn, table: conn.execute("SELECT 1").fetchall()
            )
        self.assertEqual(len(invalidate_log), 1)

    def test_no_msg_table_returns_empty(self):
        db = _FlakyMsgConnDb([], [])
        self.assertEqual(
            db._run_msg_query("wxid_a", lambda conn, table: conn.execute("SELECT 1")),
            [],
        )


if __name__ == "__main__":
    unittest.main()
