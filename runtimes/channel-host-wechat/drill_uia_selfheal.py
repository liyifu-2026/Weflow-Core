# -*- coding: utf-8 -*-
"""自愈演练：把 gate 字节清零（等价于微信重启/升级后的状态），
再让 UIA 引擎自行重新激活——验证「升级后不用改代码也能恢复」。

同时清空进程内的已验证缓存，强制走「版本实测表 + 特征扫描」路径。
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wechatauto import uia_driver  # noqa: E402
from wechatauto.uia_driver import (  # noqa: E402
    PROCESS_QUERY_INFORMATION,
    PROCESS_VM_OPERATION,
    PROCESS_VM_READ,
    PROCESS_VM_WRITE,
    QACCESSIBLE_ACTIVE_RVA_BY_VERSION,
    WeChatUIA,
    _VERIFIED_GATE_RVA,
)

uia = WeChatUIA()
hwnds = uia._wechat_hwnds()
print("wechat hwnds:", hwnds)
assert hwnds, "微信主窗口未找到"
h = hwnds[0]
pid = uia._pid_from_hwnd(h)
base, _size, dll = uia._weixin_dll_module(pid)
rva = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(os.path.basename(os.path.dirname(dll)))
print("pid=%s dll=%s gate_rva=%#x" % (pid, os.path.basename(dll), rva))

access = (PROCESS_QUERY_INFORMATION | PROCESS_VM_READ |
          PROCESS_VM_WRITE | PROCESS_VM_OPERATION)
k32 = ctypes.windll.kernel32
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.OpenProcess.restype = wintypes.HANDLE
handle = k32.OpenProcess(access, False, pid)
assert handle, "OpenProcess 失败"
try:
    print("\n[1] 当前 gate =", uia._read_process_byte(handle, base + rva))
    print("    find_main =", bool(uia._find_main()))

    uia._write_process_byte(handle, base + rva, 0)
    time.sleep(0.3)
    print("\n[2] 写入 0 后 gate =", uia._read_process_byte(handle, base + rva))
    time.sleep(0.5)
    print("    _mmui_present =", uia._mmui_present(h, timeout=0.5))

    # 模拟全新进程：清掉已验证缓存，强制走版本表/扫描
    _VERIFIED_GATE_RVA.clear()
    eng = WeChatUIA()
    t0 = time.time()
    ok = eng.ensure_window()
    print("\n[3] 新引擎 ensure_window =", ok, "(%.1fs)" % (time.time() - t0))
    print("    重新激活后 find_main =", eng._find_main() is not None)
    print("    gate =", uia._read_process_byte(handle, base + rva))
    print("    已验证缓存 =", dict(_VERIFIED_GATE_RVA))
finally:
    k32.CloseHandle(handle)
