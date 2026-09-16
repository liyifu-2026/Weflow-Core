# -*- coding: utf-8 -*-
"""本机发送链路实测：UIA 单步 + 完整 send_msg（文件传输助手）。

注意：会短暂接管键鼠（激活微信窗口）。"""
import logging
import time

logging.basicConfig(level=logging.INFO)

from wechatauto.guia import WeChatGUI  # noqa: E402
from wechatauto.uia_driver import WeChatUIA  # noqa: E402

target = "文件传输助手"

print("=== 1) UIA 布局自检 ===")
uia = WeChatUIA()
print("  ensure_window:", uia.ensure_window())
print("  wechat_hwnds:", uia._wechat_hwnds())
print("  find_main:", uia._find_main())

print()
print("=== 2) UIA open_chat(%s) ===" % target)
t0 = time.time()
opened = uia.open_chat(target)
print("  open_chat =", opened, " (%.1fs)" % (time.time() - t0))
print("  current_chat =", repr(uia.current_chat()))

print()
print("=== 3) UIA send_text ===")
text = "【UIA自检】%d" % int(time.time())
t0 = time.time()
try:
    ok = uia.send_text(text)
    print("  send_text =", ok, " (%.1fs)" % (time.time() - t0))
except Exception as e:
    import traceback
    traceback.print_exc()
    ok = False

print()
print("=== 4) 完整 send_msg(verify=True) ===")
text2 = "【通道自检】%d" % int(time.time())
t0 = time.time()
try:
    gui = WeChatGUI()
    print("  gui ok | main_hwnd=%s render_hwnd=%s" % (gui.main_hwnd, gui.render_hwnd))
    resp = gui.send_msg(text2, target, verify=True)
    print("  result:", resp)
    print("  db.is_self_sender(2, target) =",
          gui._get_db().is_self_sender(2, target))
except Exception as e:
    import traceback
    traceback.print_exc()
print("  elapsed: %.1fs" % (time.time() - t0))
