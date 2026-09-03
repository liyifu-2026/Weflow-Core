"""_detect_mentioned 的三层 @ 检测单测。

语义（与原实现一致）：
- True  = 明确被 @（昵称 / wxid / 群聊降级任一命中）
- False = 明确未被 @（所有层都未命中）
- None  = 无法判定（自消息 / 空内容）

私聊永不走群聊降级层。
"""

import os
import sys
import unittest

sys.path.insert(
    0,
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)

from channel_host.host import _detect_mentioned  # noqa: E402


class DetectMentionedTest(unittest.TestCase):
    def test_exact_nickname_match(self):
        self.assertTrue(
            _detect_mentioned("大家好 @张三 看看这个", False, "张三", is_group=True)
        )

    def test_exact_nickname_miss_without_fallback_inputs(self):
        # 昵称不匹配、无 wxid、非群聊 → 明确未被 @（False）
        self.assertIs(
            _detect_mentioned("你好", False, "张三"), False
        )

    def test_wxid_mention_match(self):
        self.assertTrue(
            _detect_mentioned(
                "@wxid_abc123 看看",
                False,
                "张三",
                self_ref="wxid_abc123",
                is_group=True,
            )
        )

    def test_group_fallback_any_at_token(self):
        # 昵称/wxid 都没命中，但群聊正文含 @ → 宽松降级为被提及
        self.assertTrue(
            _detect_mentioned(
                "@李四 帮忙看下", False, "张三", self_ref="wxid_self", is_group=True
            )
        )

    def test_private_chat_never_falls_back(self):
        # 私聊含 @ 不触发（无群聊降级层）→ False
        self.assertIs(
            _detect_mentioned("@李四 你好", False, "张三", self_ref="wxid_self"),
            False,
        )

    def test_self_message_always_none(self):
        self.assertIsNone(
            _detect_mentioned("@张三", True, "张三", self_ref="wxid_self", is_group=True)
        )

    def test_regex_special_chars_in_nickname_are_escaped(self):
        # 昵称含正则元字符时不应抛错：完整命中 → True；未命中 → False
        self.assertTrue(
            _detect_mentioned("@张三(测试) 你好", False, "张三(测试)")
        )
        # 只有昵称前缀「@张三」出现而完整昵称「张三(测试)」未出现 → False
        self.assertIs(
            _detect_mentioned("@张三 你好", False, "张三(测试)"), False
        )

    def test_empty_or_none_content(self):
        self.assertIsNone(_detect_mentioned("", False, "张三", is_group=True))


if __name__ == "__main__":
    unittest.main()
