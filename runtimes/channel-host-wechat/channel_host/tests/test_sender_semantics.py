# -*- coding: utf-8 -*-
"""real_sender_id 语义回归测试。

背景（2026-09-15 X230 实测）：微信 4.1.15.9 的 SenderName2Id 中，本机账号
拥有真实 rowid（id=1 → 本机 wxid），而经典约定「2=自己」不再成立——
id=2 实际是私聊对端。旧实现把对方消息误判为 is_self，导致：
  - 对方消息被记为 outbound（前端显示为系统事件、agent 不处理）；
  - 本机自己发出的消息被记为 inbound（agent 反而会去回复自己）。
"""

import unittest

from channel_host.host import WeChatChannelHost, _sender_and_content
from wechatauto.db import WeChatDB


def _db_stub(index, self_wxid="wxid_self"):
    """真实 WeChatDB 骨架（跳过 __init__/加解密），只喂 sender 索引与自机身份。"""
    db = WeChatDB.__new__(WeChatDB)
    db._self_username_cache = None
    db._self_sender_ids_cache = None
    db._sender_id_cache = dict(index)      # _sender_id_index() 直接命中缓存
    db.get_self_info = lambda: {"username": self_wxid}
    return db


def _host(index):
    host = WeChatChannelHost.__new__(WeChatChannelHost)
    host.db = _db_stub(index)
    host._self_ref = None
    host._self_nickname = None
    host._self_sender_ids_cache = None
    host.account = None
    return host


class SenderSemanticsTests(unittest.TestCase):
    def test_index_resolved_self_rowid_is_self(self):
        # 行号能反查到本机 → 自己（群消息里常用真实行号）
        host = _host({1: "wxid_self"})
        self.assertTrue(host._is_self_sender(1))

    def test_index_resolved_peer_rowid_is_not_self(self):
        # X230 现场形状：对端占行号 2（索引可反查）→ 不是自己
        host = _host({1: "wxid_self", 2: "wxid_leaif"})
        self.assertFalse(host._is_self_sender(2, "wxid_leaif"))
        self.assertTrue(host._is_self_sender(1, "wxid_leaif"))

    def test_unmapped_sentinel_in_private_chat_is_self(self):
        # 开发机现场形状：对端占行号 1，自己发出的消息行号是 2（未映射哨兵）
        host = _host({1: "wxid_leaif", 6: "wxid_self"})
        self.assertTrue(host._is_self_sender(2, "wxid_leaif"))
        self.assertFalse(host._is_self_sender(1, "wxid_leaif"))

    def test_missing_sender_id_is_not_self(self):
        host = _host({1: "wxid_self"})
        self.assertFalse(host._is_self_sender(None))

    def test_string_sender_identity_compared_with_self_ref(self):
        host = _host({1: "wxid_self"})
        self.assertTrue(host._is_self_sender("wxid_self"))
        self.assertFalse(host._is_self_sender("wxid-alice"))


class SenderContentTests(unittest.TestCase):
    def test_numeric_peer_id_in_private_chat_resolves_to_peer_ref(self):
        self.assertEqual(
            _sender_and_content(
                "hi", 2, "wxid_self", is_self=False, peer_ref="wxid_peer"
            ),
            ("wxid_peer", "hi"),
        )

    def test_string_identity_is_preserved(self):
        self.assertEqual(
            _sender_and_content(
                "hi", "wxid-alice", "wxid_self", is_self=False, peer_ref="room-1"
            ),
            ("wxid-alice", "hi"),
        )

    def test_self_sender_maps_to_self_ref(self):
        self.assertEqual(
            _sender_and_content(
                "hi", 1, "wxid_self", is_self=True, peer_ref="wxid_peer"
            ),
            ("wxid_self", "hi"),
        )

    def test_group_prefix_still_extracts_sender(self):
        self.assertEqual(
            _sender_and_content(
                "wxid_alice:\nhi", 5, "wxid_self", is_self=False, peer_ref=None
            ),
            ("wxid_alice", "hi"),
        )


if __name__ == "__main__":
    unittest.main()
