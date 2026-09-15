# -*- coding: utf-8 -*-
"""v1.1.3 回归测试：WAL 合并后坏缓存死循环修复（已适配上游 1.2.2 跨分片机制）。

背景：旧 `_check_merged` 只查 `sqlite_master`（schema 树），数据页损坏仍能通过
校验，坏缓存被 stamp 标为「最新」后被轮询复用，反复抛
``database disk image is malformed`` 形成死循环。

上游 1.2.2 语义差异（本测试已对齐）：
- ``_invalidate_cache()`` 为实例方法、清空 workdir 全部 .db/.stamp（无参）；
- ``_run_msg_query(user, build)`` 的 build 收到 ``[(conn, table), ...]`` 全分片；
- 找不到会话返回 ``None``（调用方转空列表）。
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


class _FlakyMsgConnDb(WeChatDB):
    """用可编程的 _msg_conns 替身驱动 _run_msg_query 的重试语义。"""

    def __init__(self, conns_per_call, invalidate_log):
        # 不调用父类 __init__：无需真实微信数据目录
        self._conns_per_call = list(conns_per_call)
        self.invalidate_log = invalidate_log
        self.workdir = "<workdir>"

    def _msg_conns(self, user, _retry=True):
        if not self._conns_per_call:
            return []
        item = self._conns_per_call.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def _message_dbs(self):
        return [os.path.join("message", "message_1.db")]

    def _invalidate_cache(self):
        self.invalidate_log.append("invalidate")


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
        # 上游语义：清空 workdir 内全部 .db/.stamp，非缓存文件保留
        stamp = self.dst + ".stamp"
        with open(stamp, "w") as f:
            f.write("2,0,0,0,0,0")
        keep = os.path.join(self.tmp.name, "keep.txt")
        with open(keep, "w") as f:
            f.write("k")

        db = object.__new__(WeChatDB)
        db.workdir = self.tmp.name
        db._invalidate_cache()

        self.assertFalse(os.path.exists(self.dst))
        self.assertFalse(os.path.exists(stamp))
        self.assertTrue(os.path.exists(keep))

    def test_invalidate_cache_tolerates_missing_files(self):
        db = object.__new__(WeChatDB)
        db.workdir = os.path.join(self.tmp.name, "absent-dir")
        db._invalidate_cache()  # 不得抛异常


class _MalformedConn:
    """查询即抛 malformed 的连接桩（模拟数据页损坏的缓存）。"""

    def __init__(self):
        self.closed = False

    def execute(self, *args, **kwargs):
        raise sqlite3.DatabaseError("database disk image is malformed")

    def close(self):
        self.closed = True


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

    @staticmethod
    def _fetch_first(tables):
        conn, table = tables[0]
        return conn.execute("SELECT * FROM %s" % table).fetchall()

    def test_malformed_cache_is_invalidated_and_retried(self):
        good = self._healthy_conn()
        invalidate_log = []
        db = _FlakyMsgConnDb(
            [
                [(_MalformedConn(), "Msg_x")],  # 第一次：缓存损坏
                [good],                          # 清缓存重建后命中
            ],
            invalidate_log,
        )
        rows = db._run_msg_query("wxid_a", self._fetch_first)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["local_id"], 7)
        self.assertEqual(rows[0]["message_content"], "hi")
        self.assertEqual(len(invalidate_log), 1)
        good[0].close()

    def test_non_malformed_database_error_raises_immediately(self):
        invalidate_log = []
        db = _FlakyMsgConnDb(
            [[(sqlite3.connect(":memory:"), "Msg_x")]],
            invalidate_log,
        )

        def build(_tables):
            raise sqlite3.DatabaseError("no such table: Msg_x")

        with self.assertRaises(sqlite3.DatabaseError):
            db._run_msg_query("wxid_a", build)
        self.assertEqual(invalidate_log, [])

    def test_malformed_error_second_time_raises(self):
        invalidate_log = []
        db = _FlakyMsgConnDb(
            [
                [(sqlite3.connect(":memory:"), "Msg_x")],
                [(sqlite3.connect(":memory:"), "Msg_x")],
            ],
            invalidate_log,
        )

        def build(_tables):
            raise sqlite3.DatabaseError("database disk image is malformed")

        with self.assertRaises(sqlite3.DatabaseError):
            db._run_msg_query("wxid_a", build)
        self.assertEqual(len(invalidate_log), 1)

    def test_no_msg_table_returns_none(self):
        # 上游语义：找不到会话返回 None（调用方 get_messages 转空列表）
        db = _FlakyMsgConnDb([], [])
        self.assertIsNone(
            db._run_msg_query("wxid_a", lambda tables: tables)
        )


if __name__ == "__main__":
    unittest.main()
