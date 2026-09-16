# -*- coding: utf-8 -*-
"""WeChatDB 自适应发送者判定回归测试（单一事实源）。

背景（两台实机实测，同一微信 4.1.15.x、同一账号）：

* 开发机：``SenderName2Id = {1: Leaif, 3..5: 其他联系人, 6: 本机, 7: ...}``，
  **自己发出去的消息 real_sender_id=2**（程序向文件传输助手发送后实测），
  对端 Leaif 的消息是 1。——索引里出现本机 wxid（行号 6）并不代表
  「自己发的消息用 6」，旧实现据此反推会把消息判反。
* X230：对端 Leaif 的消息 real_sender_id=2（前端表现为把对方消息标成
  自家系统事件，agent 不回复）。

因此判定不能只看「索引里谁是本机」，要走索引反查 + 私聊上下文：
  1. 行号能在 SenderName2Id 反查到 → 以反查结果为准；
  2. 反查不到 + 私聊且对端行号已知 → 不是对端即自己；
  3. 都判不出 → 经典约定 2=自己。
"""

import unittest

from wechatauto.db import WeChatDB


def _db(index, self_wxid="wxid_self"):
    db = WeChatDB.__new__(WeChatDB)
    db._self_username_cache = None
    db._self_sender_ids_cache = None
    db._sender_id_cache = dict(index)
    db.get_self_info = lambda: {"username": self_wxid}
    return db


class SelfSenderDetectionTests(unittest.TestCase):
    def test_dev_machine_shape_self_sentinel_two_in_private_chat(self):
        # 开发机实测索引：对端 1、本机 6；自己发出的消息行号是 2（哨兵值）
        db = _db({1: "wxid_leaif", 3: "wxid_c", 6: "wxid_self", 7: "wxid_d"})
        self.assertTrue(db.is_self_sender(2, "wxid_leaif"))
        self.assertFalse(db.is_self_sender(1, "wxid_leaif"))
        # 索引反查到本机行号（群消息里自己可能用真实行号）
        self.assertTrue(db.is_self_sender(6, "wxid_leaif"))

    def test_x230_shape_peer_two_is_not_self(self):
        # X230 现场：对端行号 2、本机行号 1
        db = _db({1: "wxid_self", 2: "wxid_leaif"})
        self.assertFalse(db.is_self_sender(2, "wxid_leaif"))
        self.assertTrue(db.is_self_sender(1, "wxid_leaif"))

    def test_unmapped_id_falls_back_to_classic_sentinel(self):
        # 无会话上下文时：未映射行号按经典约定 2=自己（上游文档语义）
        db = _db({2: "wxid_other"})
        self.assertFalse(db.is_self_sender(2))          # 索引说 2 是别人 → 以索引为准
        db = _db({3: "wxid_other"})
        self.assertTrue(db.is_self_sender(2))           # 2 未映射 → 经典哨兵
        self.assertFalse(db.is_self_sender(1))

    def test_group_chat_does_not_use_private_chat_inference(self):
        # 群聊里行号反查不到的成员消息不得因为「不是对端」就当成自己
        db = _db({1: "wxid_leaif", 6: "wxid_self"})
        self.assertFalse(db.is_self_sender(5, "12345@chatroom"))
        self.assertTrue(db.is_self_sender(2, "12345@chatroom"))   # 无前缀的自己消息

    def test_string_identity_compared_with_self_username(self):
        db = _db({1: "wxid_self"})
        self.assertTrue(db.is_self_sender("wxid_self"))
        self.assertFalse(db.is_self_sender("wxid_leaif"))

    def test_none_is_never_self(self):
        db = _db({1: "wxid_self"})
        self.assertFalse(db.is_self_sender(None))

    def test_contact_sender_ids(self):
        db = _db({1: "wxid_leaif", 4: "wxid_leaif", 6: "wxid_self"})
        self.assertEqual(db.contact_sender_ids("wxid_leaif"), frozenset({1, 4}))
        self.assertEqual(db.contact_sender_ids("wxid_unknown"), frozenset())

    def test_sender_index_read_is_cached(self):
        # 判定高频调用（每条消息、每次发送回执），索引必须走进程内缓存：
        # 预置缓存后，任何再次开库读取都应视为失败
        db = _db({1: "wxid_self", 2: "wxid_leaif"})

        def boom(*_a, **_k):
            raise AssertionError("索引已缓存，不应再开库读取")

        db._open = boom
        db.contact_sender_ids("wxid_self")
        db.contact_sender_ids("wxid_self")
        self.assertTrue(db.is_self_sender(1))
        self.assertFalse(db.is_self_sender(2, "wxid_leaif"))


if __name__ == "__main__":
    unittest.main()
