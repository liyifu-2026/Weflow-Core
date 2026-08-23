import ctypes
import unittest
from types import SimpleNamespace

from wechatauto.guia import WeChatGUI, _rect_intersection_area


class _FakeUser32:
    def __init__(self, rects, classes, visible, children):
        self.rects = rects
        self.classes = classes
        self.visible = visible
        self.children = children

    def IsWindow(self, hwnd):
        return hwnd in self.rects

    def IsWindowVisible(self, hwnd):
        return self.visible.get(hwnd, False)

    def GetClassNameW(self, hwnd, buffer, _size):
        buffer.value = self.classes.get(hwnd, "")

    def GetWindowRect(self, hwnd, pointer):
        rect = ctypes.cast(pointer, ctypes.POINTER(type(pointer._obj))).contents
        rect.left, rect.top, rect.right, rect.bottom = self.rects[hwnd]
        return 1

    def GetSystemMetrics(self, metric):
        return {
            76: 0,    # SM_XVIRTUALSCREEN
            77: 0,    # SM_YVIRTUALSCREEN
            78: 1920, # SM_CXVIRTUALSCREEN
            79: 1080, # SM_CYVIRTUALSCREEN
        }[metric]

    def EnumChildWindows(self, _parent, callback, lparam):
        for child in self.children:
            if not callback(child, lparam):
                break


class RenderWindowSelectionTests(unittest.TestCase):
    def test_intersection_area_ignores_screen_disjoint_rectangles(self):
        self.assertEqual(
            _rect_intersection_area((10, 10, 30, 30), (20, 20, 40, 40)),
            100,
        )
        self.assertEqual(
            _rect_intersection_area((-32000, -32000, -30000, -30000), (0, 0, 1920, 1080)),
            0,
        )

    def test_find_render_window_rejects_offscreen_large_surface(self):
        main = 1
        hidden_large = 2
        offscreen_large = 3
        visible_render = 4
        user32 = _FakeUser32(
            rects={
                main: (100, 100, 1100, 900),
                hidden_large: (100, 100, 1100, 900),
                offscreen_large: (-32000, -32000, -30000, -30000),
                visible_render: (100, 100, 1100, 900),
            },
            classes={
                hidden_large: "MMUIRenderSubWindowHW",
                offscreen_large: "MMUIRenderSubWindowHW",
                visible_render: "MMUIRenderSubWindowHW",
            },
            visible={
                hidden_large: False,
                offscreen_large: True,
                visible_render: True,
            },
            children=[hidden_large, offscreen_large, visible_render],
        )
        gui = WeChatGUI.__new__(WeChatGUI)
        gui._input = SimpleNamespace(_user32=user32)

        self.assertEqual(gui._find_render_window(main), visible_render)


if __name__ == "__main__":
    unittest.main()
