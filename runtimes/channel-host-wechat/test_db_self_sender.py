# -*- coding: utf-8 -*-
"""WeChatDB 自适应发送者判定回归测试（单一事实源）。

背景（两台实机实测，都是微信 4.1.15.x、同一个账号）：

* 开发机：``SenderName2Id = {1: Leaif, 3..5: 其他联系人, 6: 本机, 7: ...}``；
  **自己发出去的消息 real_sender_id=2**（程序向文件传输助手发送后实测），
  对端 Leaif 是 1。
* X230：``SenderName2Id = {1: 本机}``；**自己发出去的消息 real_sender_id=1**，
  **对端 Leaif 是 2**。

也就是说「2=自己」既不是普适常量，索引里出现本机 wxid 也不代表自己发的消息
用它。因此判定顺序是：索引反查 → 从文件传输助手学到的本机行号 → 私聊非对端
即自己 → 经典 2=自己。
"""

import time
import unittest

from wechatauto.db import WeChatDB


def _db(index, self_wxid="wxid_self", learned=None):
    db = WeChatDB.__new__(WeChatDB)
    db._self_username_cache = None
    db._self_sender_ids_cache = None
    db._sender_id_cache = dict(index)
    db.get_self_info = lambda: {"username": self_wxid}
    # 直接注入「从文件传输助手学到的本机行号」缓存，避免真去开库
    db._learned_self_ids = (time.time(), frozenset(learned or ()))
    return db


class SelfSenderDetectionTests(unittest.TestCase):
    def test_dev_machine_shape_self_is_two(self):
        # 开发机实测：对端 1（可反查）、自己 2（学自文件传输助手）
        db = _db({1: "wxid_leaif", 3: "wxid_c", 6: "wxid_self", 7: "wxid_d"},
                 learned={2})
        self.assertTrue(db.is_self_sender(2, "wxid_leaif"))
        self.assertFalse(db.is_self_sender(1, "wxid_leaif"))
        self.assertTrue(db.is_self_sender(6, "wxid_leaif"))   # 索引反查到本机

    def test_x230_shape_peer_is_two(self):
        # X230 实测：本机 1（可反查）、对端 2；把 2 当自己正是最初的线上 bug
        db = _db({1: "wxid_self"}, learned={1})
        self.assertTrue(db.is_self_sender(1, "wxid_leaif"))
        self.assertFalse(db.is_self_sender(2, "wxid_leaif"))
        self.assertFalse(db.is_self_sender(2, "filehelper"))

    def test_learned_ids_beat_classic_sentinel(self):
        db = _db({}, learned={5})
        self.assertTrue(db.is_self_sender(5, "wxid_leaif"))
        self.assertFalse(db.is_self_sender(2, "wxid_leaif"))

    def test_without_learned_falls_back_to_private_chat_inference(self):
        # 文件传输助手为空（学不到）时：私聊里对端行号已知，非对端即自己
        db = _db({1: "wxid_leaif"})
        self.assertTrue(db.is_self_sender(2, "wxid_leaif"))
        self.assertFalse(db.is_self_sender(1, "wxid_leaif"))

    def test_without_any_evidence_keeps_classic_two(self):
        db = _db({})
        self.assertTrue(db.is_self_sender(2))
        self.assertFalse(db.is_self_sender(3))

    def test_group_chat_does_not_use_private_chat_inference(self):
        db = _db({1: "wxid_leaif"})
        self.assertFalse(db.is_self_sender(5, "12345@chatroom"))
        self.assertTrue(db.is_self_sender(2, "12345@chatroom"))   # 经典约定

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
        # 判定高频调用（每条消息、每次发送回执），索引必须走进程内缓存
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
