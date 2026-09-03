import sqlite3
import unittest

import zstandard

from wechatauto.db import WeChatDB, _md5_hex


class WeChatTextDecodeTests(unittest.TestCase):
    def test_zstandard_text_is_returned_as_text_instead_of_placeholder(self):
        expected = "软件打不开，错误码2272。"
        compressed = zstandard.ZstdCompressor().compress(expected.encode("utf-8"))

        self.assertEqual(
            WeChatDB._friendly_content(compressed, "文本"),
            expected,
        )

    def test_container_with_plaintext_and_fill_is_stripped(self):
        # 「明文 + \x01\x00 填充」格式：明文取首个 \x01 之前的部分
        self.assertEqual(
            WeChatDB._friendly_content(b"hello\x01\x00\x00", "文本"),
            "hello",
        )

    def test_plain_text_unchanged(self):
        self.assertEqual(
            WeChatDB._friendly_content(b"plain text", "文本"),
            "plain text",
        )


class _MsgConnDb(WeChatDB):
    """单次使用的 _msg_conn 替身（连接在 _run_msg_query finally 中关闭）。"""

    def __init__(self, conn, table):
        self._conn = conn
        self._table = table

    def _msg_conn(self, user):
        return self._conn, self._table


def _msg_table_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    table = "Msg_" + _md5_hex(b"wxid_a")
    conn.execute(
        f"CREATE TABLE {table} (local_id INTEGER, local_type INTEGER, "
        "real_sender_id TEXT, create_time INTEGER, message_content BLOB, "
        "source BLOB, packed_info_data BLOB, compress_content BLOB, "
        "sort_seq INTEGER)"
    )
    return conn, table


class CompressContentFallbackTests(unittest.TestCase):
    def test_placeholder_content_falls_back_to_compress_content(self):
        # message_content 为不可解码的二进制（退化为占位符），
        # compress_content 为 zstd 压缩文本 → 应回退出原文
        expected = "这条长文本存在 compress_content 里"
        cc = zstandard.ZstdCompressor().compress(expected.encode("utf-8"))
        conn, table = _msg_table_conn()
        conn.execute(
            f"INSERT INTO {table} VALUES (?,?,?,?,?,?,?,?,?)",
            (1, 1, "wxid_x", 100, b"\xff\xfe\xfd\xfc", None, None, cc, 1),
        )
        conn.commit()

        rows = _MsgConnDb(conn, table).get_messages("wxid_a")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["content"], expected)
        self.assertEqual(rows[0]["type"], "文本")

    def test_unreadable_compress_content_keeps_placeholder(self):
        # compress_content 也不是可解文本 → 保持占位符，不抛异常
        conn, table = _msg_table_conn()
        conn.execute(
            f"INSERT INTO {table} VALUES (?,?,?,?,?,?,?,?,?)",
            (1, 47, "wxid_x", 100, b"\xff\xfe\xfd\xfc", None, None,
             b"\x00\x01\x02", 1),
        )
        conn.commit()

        rows = _MsgConnDb(conn, table).get_messages("wxid_a")
        self.assertEqual(rows[0]["content"], "[动画表情]")

    def test_direct_plaintext_not_overridden_by_placeholder_logic(self):
        conn, table = _msg_table_conn()
        conn.execute(
            f"INSERT INTO {table} VALUES (?,?,?,?,?,?,?,?,?)",
            (1, 1, "wxid_x", 100, b"direct text", None, None, None, 1),
        )
        conn.commit()

        rows = _MsgConnDb(conn, table).get_messages("wxid_a")
        self.assertEqual(rows[0]["content"], "direct text")


if __name__ == "__main__":
    unittest.main()
