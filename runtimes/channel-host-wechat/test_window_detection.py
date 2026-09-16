# -*- coding: utf-8 -*-
"""微信主窗口判定的回归测试（纯函数，无窗口依赖）。

背景（2026-09-16 开发机实测）：微信 4.x 主窗口标题是**账号昵称**，客服号
的标题就是「客服」。旧判定要求标题含「微信/Weixin」，主窗口被整个漏掉 →
UIA 树永远「不可用」→ 发送退化到 OCR 物理鼠标路径（鼠标乱跑且发不出去）。
"""

import unittest

from wechatauto.uia_driver import (
    MIN_WINDOW_EDGE,
    _looks_like_wechat_window,
    _title_is_main,
)


class WeChatWindowPredicateTests(unittest.TestCase):
    def test_nickname_title_still_matches_by_class_and_process(self):
        # 回归：标题是账号昵称「客服」，靠类名 + 进程名 + 尺寸识别
        self.assertTrue(_looks_like_wechat_window(
            "客服", "Qt51514QWindowIcon", "weixin.exe", 866, 701))

    def test_materialized_window_class_matches(self):
        # 热激活后类名变成 mmui::MainWindow，标题仍是昵称
        self.assertTrue(_looks_like_wechat_window(
            "客服", "mmui::MainWindow", "weixin.exe", 866, 701))

    def test_future_qt_major_upgrade_class_still_matches(self):
        # Qt 大版本升级改名（Qt51514 → Qt6xx）不应失效
        self.assertTrue(_looks_like_wechat_window(
            "", "Qt6QWindowIcon", "weixin.exe", 900, 700))

    def test_legacy_title_still_matches(self):
        self.assertTrue(_looks_like_wechat_window(
            "微信", "SomeOtherClass", "weixin.exe", 900, 700))

    def test_foreign_process_is_rejected(self):
        # 标题像微信但进程不是 weixin.exe（如浏览器标签页标题）
        self.assertFalse(_looks_like_wechat_window(
            "微信", "Qt51514QWindowIcon", "chrome.exe", 1200, 900))

    def test_tiny_windows_are_rejected(self):
        # 托盘/1x1 辅助窗口（标题 'Weixin'）不是主窗口
        self.assertFalse(_looks_like_wechat_window(
            "Weixin", "Qt51514QWindowIcon", "weixin.exe", 1, 1))

    def test_tray_message_window_class_is_rejected(self):
        # 托盘消息窗口：类名以 Qt 开头但不以 QWindowIcon 结尾
        self.assertFalse(_looks_like_wechat_window(
            "WxTrayIconMessageWindow", "Qt51514WxTrayIconMessageWindowClass",
            "weixin.exe", 1280, 665))

    def test_min_edge_boundary(self):
        self.assertTrue(_looks_like_wechat_window(
            "", "Qt51514QWindowIcon", "weixin.exe", MIN_WINDOW_EDGE, MIN_WINDOW_EDGE))
        self.assertFalse(_looks_like_wechat_window(
            "", "Qt51514QWindowIcon", "weixin.exe", MIN_WINDOW_EDGE - 1, 800))

    def test_title_helper_keeps_supporting_both_names(self):
        self.assertTrue(_title_is_main("微信"))
        self.assertTrue(_title_is_main("Weixin"))
        self.assertFalse(_title_is_main("客服"))


if __name__ == "__main__":
    unittest.main()
