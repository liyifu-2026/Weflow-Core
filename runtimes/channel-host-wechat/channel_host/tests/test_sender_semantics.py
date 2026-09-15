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


class _DbStub:
    def __init__(self, index):
        self._index = index

    def get_self_info(self):
        return {"username": "wxid_self"}

    def _sender_id_index(self):
        return self._index


def _host(index):
    host = WeChatChannelHost.__new__(WeChatChannelHost)
    host.db = _DbStub(index)
    host._self_ref = None
    host._self_nickname = None
    host._self_sender_ids_cache = None
    host.account = None
    return host


class SenderSemanticsTests(unittest.TestCase):
    def test_new_wechat_semantics_uses_real_self_rowid(self):
        # 4.1.15+：索引含本机 rowid（1=本机）；2 是对方，不得视为自己
        host = _host({1: "wxid_self"})
        self.assertTrue(host._is_self_sender(1))
        self.assertFalse(host._is_self_sender(2))

    def test_legacy_wechat_keeps_classic_two_as_self(self):
        # ≤4.1.12：索引不含本机行 → 回退经典约定 2=自己
        host = _host({2: "wxid_someone", 3: "wxid_other"})
        self.assertTrue(host._is_self_sender(2))
        self.assertFalse(host._is_self_sender(3))

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
