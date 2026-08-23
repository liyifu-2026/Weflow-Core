import unittest

import zstandard

from wechatauto.db import WeChatDB


class WeChatTextDecodeTests(unittest.TestCase):
    def test_zstandard_text_is_returned_as_text_instead_of_placeholder(self):
        expected = "软件打不开，错误码2272。"
        compressed = zstandard.ZstdCompressor().compress(expected.encode("utf-8"))

        self.assertEqual(
            WeChatDB._friendly_content(compressed, "文本"),
            expected,
        )


if __name__ == "__main__":
    unittest.main()
