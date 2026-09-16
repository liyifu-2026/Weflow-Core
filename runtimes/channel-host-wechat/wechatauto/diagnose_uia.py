# -*- coding: utf-8 -*-
"""UIA/发送链路现场诊断（微信升级后排查用）。

用法（在 channel-host-wechat 目录下、用其 venv）::

    .venv/Scripts/python.exe wechatauto/diagnose_uia.py            # 只读诊断
    .venv/Scripts/python.exe wechatauto/diagnose_uia.py --activate # 顺带热激活一次

输出：窗口枚举（含为什么被选中/排除）、gate 字节当前值、候选 RVA 与来源、
mmui 树是否物化、当前会话与输入框锚点。微信升级后 UIA 失效时，先跑这个。
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import win32gui          # noqa: E402
import win32process      # noqa: E402

from wechatauto.uia_driver import (      # noqa: E402
    QACCESSIBLE_ACTIVE_RVA_BY_VERSION,
    WeChatUIA,
    _looks_like_wechat_window,
)


def _rows(uia: WeChatUIA):
    rows = []

    def cb(h, _):
        try:
            vis = win32gui.IsWindowVisible(h)
            cls = win32gui.GetClassName(h)
            title = win32gui.GetWindowText(h)
            pid = win32process.GetWindowThreadProcessId(h)[1]
            exe = uia._process_exe_name(pid)
            l, t, r, b = win32gui.GetWindowRect(h)
            if not vis:
                return True
            if exe != "weixin.exe" and "Qt" not in cls and "mmui" not in cls:
                return True
            rows.append((h, pid, exe, cls, title, (r - l, b - t),
                         _looks_like_wechat_window(title, cls, exe, r - l, b - t)))
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(cb, None)
    except Exception:
        pass
    return rows


def main() -> int:
    do_activate = "--activate" in sys.argv
    uia = WeChatUIA()

    print("=== 主窗口候选（visible 且属微信进程）===")
    for h, pid, exe, cls, title, size, ok in _rows(uia):
        print("  hwnd=%-8s pid=%-6s exe=%-12r cls=%-32r title=%-12r size=%-12s 选中=%s"
              % (h, pid, exe, cls, title[:10], size, ok))
    hwnds = uia._wechat_hwnds()
    print("  → _wechat_hwnds =", hwnds)
    if not hwnds:
        print("未识别到微信主窗口：确认微信已登录并显示主界面")
        return 2

    hwnd = hwnds[0]
    pid = uia._pid_from_hwnd(hwnd)
    mod = uia._weixin_dll_module(pid)
    print()
    print("=== 进程 / DLL ===")
    print("  pid=%s dll=%s" % (pid, mod[2] if mod else "未找到 Weixin.dll"))
    if not mod:
        return 2
    base, _size, dll_path = mod
    identity = os.path.basename(os.path.dirname(dll_path))
    print("  版本目录: %s" % identity)
    print("  版本表命中: %s" % (QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(identity) and
                               hex(QACCESSIBLE_ACTIVE_RVA_BY_VERSION[identity]) or "无"))

    print()
    print("=== mmui 树现状 ===")
    print("  _find_main:", "物化" if uia._find_main() is not None else "未物化（Qt 空壳）")

    print()
    print("=== gate 候选（惰性序列，按尝试顺序）===")
    for i, rva in enumerate(uia._iter_gate_candidates(dll_path)):
        print("  #%d Weixin.dll+0x%x" % (i, rva))
        if i >= 7:
            print("  ...")
            break

    if do_activate:
        print()
        print("=== 热激活 ===")
        t0 = time.time()
        ok = uia.ensure_materialized(timeout=8.0, force=True)
        print("  ensure_materialized =", ok, "(%.1fs)" % (time.time() - t0))

    print()
    print("=== 布局锚点 ===")
    rep = uia.describe_layout()
    for k, v in rep.items():
        print("  %s = %r" % (k, v))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
