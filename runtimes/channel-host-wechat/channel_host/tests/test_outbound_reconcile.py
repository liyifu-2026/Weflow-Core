# -*- coding: utf-8 -*-
"""发送对账的自适应发送者判定回归测试。

背景（2026-09-16 X230 实测）：发送对账用的 `find_self_text_after` 曾写死
``sender_id in (2, "2")``。X230 上本机发出的消息行号是 1、对端才是 2，
于是对账永远匹配不到 → 已送达的消息被记成 unknown（前端显示「发送结果未知」）。
"""

import unittest

from channel_host.outbound import WeChatChannelSender


class _DbStub:
    """只实现 outbound 用到的两个方法：get_messages + is_self_sender。"""

    def __init__(self, rows, self_ids):
        self.rows = rows
        self.self_ids = set(self_ids)
        self.calls = []

    def get_messages(self, conversation_ref, limit=200):
        return self.rows[:limit]

    def is_self_sender(self, sender_id, conversation_ref=None):
        self.calls.append((sender_id, conversation_ref))
        try:
            return int(sender_id) in self.self_ids
        except (TypeError, ValueError):
            return False


def _row(sender_id, content, sort_seq, local_id):
    return {
        "sender_id": sender_id,
        "content": content,
        "sort_seq": sort_seq,
        "local_id": local_id,
    }


class FindSelfTextTests(unittest.TestCase):
    def test_x230_shape_self_rowid_one_is_matched(self):
        # X230：本机=1、对端=2；写死 2 的旧实现会漏掉这条
        db = _DbStub([_row(1, "通道自检", 1789539, 27)], self_ids={1})
        sender = WeChatChannelSender(db)
        self.assertEqual(
            sender.find_self_text_after("wxid_leaif", "通道自检", 1789500), "27"
        )
        self.assertEqual(db.calls[0], (1, "wxid_leaif"))

    def test_peer_message_is_not_matched(self):
        # 对端消息（X230 上 sender_id=2）不能被当成自己发的那条
        db = _DbStub([_row(2, "通道自检", 1789539, 27)], self_ids={1})
        sender = WeChatChannelSender(db)
        self.assertIsNone(
            sender.find_self_text_after("wxid_leaif", "通道自检", 1789500)
        )

    def test_baseline_filters_older_messages(self):
        db = _DbStub([_row(1, "通道自检", 1789500, 12)], self_ids={1})
        sender = WeChatChannelSender(db)
        self.assertIsNone(
            sender.find_self_text_after("wxid_leaif", "通道自检", 1789500)
        )

    def test_dev_shape_self_rowid_two_still_works(self):
        db = _DbStub([_row(2, "通道自检", 1789539, 9)], self_ids={2})
        sender = WeChatChannelSender(db)
        self.assertEqual(
            sender.find_self_text_after("filehelper", "通道自检", 1789500), "9"
        )

    def test_falls_back_to_classic_check_when_db_lacks_helper(self):
        class _Legacy:
            def get_messages(self, conversation_ref, limit=200):
                return [_row(2, "通道自检", 1789539, 5)]

        sender = WeChatChannelSender(_Legacy())
        self.assertEqual(
            sender.find_self_text_after("conv", "通道自检", 1789500), "5"
        )


if __name__ == "__main__":
    unittest.main()
