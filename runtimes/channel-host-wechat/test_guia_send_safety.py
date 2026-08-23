import unittest
from unittest.mock import patch

from wechatauto.guia import WeChatGUI


class _FakeInput:
    def __init__(self):
        self.keys = []

    def key(self, key, ctrl=False):
        self.keys.append((key, ctrl))


class SendSafetyTests(unittest.TestCase):
    def test_click_send_performs_one_ambiguous_ui_attempt(self):
        gui = WeChatGUI.__new__(WeChatGUI)
        gui._input = _FakeInput()
        gui._last_input_box = (0, 0, 100, 100)
        gui.send_button_region = (0, 0, 100, 100)
        gui.origin_x = 0
        gui.origin_y = 0
        clicks = []

        gui._input_box_has_text = lambda _box: True
        gui.ocr = lambda _region: [("发送", 10, 10, 20, 20)]
        gui.wx_click = lambda x, y: clicks.append((x, y))

        with patch("wechatauto.guia.time.sleep"):
            self.assertFalse(gui.click_send())

        self.assertEqual(len(gui._input.keys), 1)
        self.assertEqual(len(clicks), 1)


if __name__ == "__main__":
    unittest.main()
