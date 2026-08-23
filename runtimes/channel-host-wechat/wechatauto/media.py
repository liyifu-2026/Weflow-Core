# -*- coding: utf-8 -*-
"""微信 4.x 媒体文件读取与下载（图片解密、语音、视频、文件）。

与 :mod:`wechatauto.db` 配合使用：``db`` 提供解密后的消息行（含 local_type、
server_id、packed_info），本模块负责把媒体内容从本地取回/解密/落地。

支持的媒体（local_type 见 :data:`wechatauto.db.MSG_TYPE_NAMES`）::

    local_type 3   图片     → 会话目录 msg/attach/<会话md5>/<YYYY-MM>/Img/<md5>.dat
    local_type 34  语音     → message/media_0.db VoiceInfo.voice_data（SILK 二进制）
    local_type 43  视频     → msg/video/<YYYY-MM>/<id>.mp4（未落地时返回 None）
    local_type 49  文件     → msg/file/<YYYY-MM>/<原文件名>，原名取自
                            message_resource.db MessageResourceDetail.packed_info

图片加密（v2 格式，本库已在本机验证）::

    结构: [6B sig 07 08 56 32 08 07][4B aes_size LE][4B xor_size LE][1B pad]
          [aes 密文(ECB, PKCS7, 对齐 16B)][raw 明文][xor 密文]

    - AES 密钥: 16 字节 ASCII（字母/数字），仅在 Weixin.exe 进程内存中。
      通过 AES-ECB 解首块密文、校验 JPEG/PNG 魔数反推出（内存正则扫描）。
    - XOR 密钥: 单字节，从同图缩略图 ``<md5>_t.dat`` 尾部 JPEG 结束标记
      ``FF D9`` 反推（``key = tail[0] ^ 0xFF``）。

用法::

    from wechatauto import WeChatDB, MediaDownloader
    db = WeChatDB()
    md = MediaDownloader(db)
    md.download_media(chat_user, msg_row["local_id"])   # 按类型自动分发
"""

from __future__ import annotations

import ctypes
import glob
import json
import os
import re
import struct
import tempfile
import threading
import time
from typing import List, Optional, Tuple

V1_MAGIC = b"\x07\x08\x05\x56\x02\x05"
V2_MAGIC = b"\x07\x08\x56\x32\x08\x07"
V1_HEADER_SZ = 22  # 6B sig + 16B xor key
AES16_RE = re.compile(rb"[0-9a-zA-Z]{16,32}")
DEFAULT_SAVE_PATH = os.path.join(os.path.expanduser("~"), "Documents", "wechatauto_media")


def _jpeg_like(pt: bytes) -> bool:
    return (
        (pt[:3] == b"\xff\xd8\xff")
        or pt[:4] in (b"\x89PNG", b"GIF8", b"RIFF")
        or pt[:4] == b"wxgf"  # 微信动画表情容器
    )


def aligned_aes_block_size(aes_size: int) -> int:
    return aes_size + (16 - aes_size % 16) if aes_size % 16 else aes_size + 16


class MediaDownloader:
    """微信 4.x 媒体下载器"""

    def __init__(self, db, save_dir: Optional[str] = None,
                 image_key: Optional[str] = None,
                 keys_file: Optional[str] = None,
                 scan_budget_seconds: float = 8.0,
                 scan_cooldown_seconds: float = 30.0):
        self.db = db
        self.save_dir = save_dir or DEFAULT_SAVE_PATH
        self._image_key = image_key  # 显式注入的图片 AES 密钥
        self._keys_file = keys_file  # 覆盖密钥持久化路径（secrets 管理）
        self._scan_budget = max(1.0, float(scan_budget_seconds))
        self._scan_cooldown = max(0.0, float(scan_cooldown_seconds))
        self._key_lock = threading.RLock()
        self._xor_key: Optional[int] = None
        self._img_key: Optional[Tuple[str, int]] = None
        self._key_probe: Optional[bytes] = None
        self._last_scan_miss: Optional[float] = None

    # ------------------------------------------------------------------
    # 图片密钥（内存扫描 + 缩略图反推）
    # ------------------------------------------------------------------
    def _probe_ct(self, dat_path: Optional[str] = None) -> bytes:
        """取一张 V2 图片的密文首块，作为密钥反测试样"""
        if self._key_probe is not None:
            return self._key_probe
        if dat_path is None:
            base = os.path.join(self.db.account_dir, "msg", "attach")
            hits = glob.glob(os.path.join(base, "*", "*", "Img", "*.dat"))
            if not hits:
                return b""
            dat_path = hits[0]
        with open(dat_path, "rb") as f:
            head = f.read(32)
        if head[:6] == V2_MAGIC:
            self._key_probe = head[15:31]
        else:
            self._key_probe = head[V1_HEADER_SZ: V1_HEADER_SZ + 16]
        return self._key_probe

    def _validate_key(self, aes_key: str) -> bool:
        """用真实密文首块反测密钥是否有效"""
        probe = self._probe_ct()
        if not probe:
            return False
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            dec = Cipher(algorithms.AES(aes_key.encode()), modes.ECB()).decryptor()
            return _jpeg_like(dec.update(probe) + dec.finalize())
        except Exception:
            return False

    def _key_store(self) -> str:
        if self._keys_file:
            return self._keys_file
        return os.path.join(self.db.workdir, "image_keys.json")

    def _load_persisted_key(self) -> Optional[str]:
        try:
            with open(self._key_store(), "r", encoding="utf-8") as f:
                saved = json.load(f)
            key = saved.get(self.db.account)
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        if key and self._validate_key(key):
            return key
        return None

    def _persist_key(self, aes_key: str) -> None:
        try:
            with open(self._key_store(), "r", encoding="utf-8") as f:
                saved = json.load(f)
        except (OSError, ValueError, json.JSONDecodeError):
            saved = {}
        saved[self.db.account] = aes_key
        try:
            os.makedirs(os.path.dirname(self._key_store()), exist_ok=True)
            with open(self._key_store(), "w", encoding="utf-8") as f:
                json.dump(saved, f, indent=2)
        except OSError:
            pass

    def _scan_aes_key(self, deadline: Optional[float] = None) -> Optional[str]:
        """从 Weixin.exe 进程内存扫描 16 字符 ASCII 密钥，用密文反测（有界单遍）。

        单个匹配串滑动测试所有 16 字符子串，避免密钥在长串中间时漏掉。
        ``deadline`` 为 time.monotonic() 绝对时限，到点立即返回 None，
        保证多 GB 内存的进程不会拖垮调用方。持续轮询等待用户看图属于
        交互场景，由 detect_image_key(wait_seconds=...) 负责；
        Channel Host 请求路径禁止调用本方法。

        微信 4.x 的图片 AES 密钥仅在查看图片大图时临时加载进内存，驻留约
        数分钟后释放。
        """
        probe = self._probe_ct()
        if not probe:
            return None
        pids = self.db._find_weixin_pids()
        if not pids:
            return None
        from . import db as _dbmod
        k32 = _dbmod._k32
        MBI = _dbmod._MBI

        def read_mem(h, addr: int, n: int):
            buf = ctypes.create_string_buffer(n)
            br = ctypes.c_size_t(0)
            if k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(br)) and br.value:
                return buf.raw[: br.value]
            return None

        def _test_candidates(buf: bytes):
            for m in AES16_RE.finditer(buf):
                group = m.group()
                if len(group) == 16:
                    yield group
                    continue
                for s in range(len(group) - 15):
                    yield group[s: s + 16]

        def _try_key(key: bytes):
            try:
                from cryptography.hazmat.primitives.ciphers import (
                    Cipher, algorithms, modes,
                )
                pt = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
                out = pt.update(probe) + pt.finalize()
            except Exception:
                return False
            return _jpeg_like(out)

        def _scan_once() -> Optional[str]:
            # 保持微信进程原顺序扫描（主进程在 _find_weixin_pids 中靠前，
            # 密钥命中率高；不要按内存排序——GetProcessMemoryInfo 结构体
            # 大小传错会全为 0，reverse 排序反而把主进程排到最后，错过窗口）
            for pid in pids:
                if deadline is not None and time.monotonic() > deadline:
                    return None
                h = k32.OpenProcess(0x0010 | 0x0400, False, pid)
                if not h:
                    continue
                try:
                    addr = 0
                    while True:
                        if deadline is not None and time.monotonic() > deadline:
                            return None
                        mbi = MBI()
                        r = k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
                        if r == 0:
                            break
                        if (
                            mbi.State == 0x1000
                            and (mbi.Protect & 0xFF) & 0xE6
                            and not (mbi.Protect & 0x100)
                            and 0 < mbi.RegionSize < 0x2000000
                        ):
                            buf = read_mem(h, mbi.BaseAddress or 0, mbi.RegionSize)
                            if buf:
                                for key in _test_candidates(buf):
                                    if _try_key(key):
                                        return key.decode()
                        addr = (mbi.BaseAddress or 0) + mbi.RegionSize
                finally:
                    k32.CloseHandle(h)
            return None

        return _scan_once()

    def _derive_xor_key(self, dat_path: str) -> int:
        """从同图缩略图 <md5>_t.dat 尾部 FF D9 反推单字节 XOR 密钥"""
        for cand in (dat_path[:-4] + "_t.dat", dat_path[:-4] + "_h.dat", dat_path):
            if not os.path.exists(cand):
                continue
            try:
                with open(cand, "rb") as f:
                    f.seek(-2, 2)
                    tail = f.read(2)
            except OSError:
                continue
            if len(tail) == 2:
                key = tail[0] ^ 0xFF
                if tail[1] ^ 0xD9 == key:
                    return key
        return 0x88

    def _current_aes_key(self) -> Optional[str]:
        """无副作用的快速解析：显式注入 → 持久化文件。不扫描进程内存。"""
        if self._image_key and self._validate_key(self._image_key):
            return self._image_key
        return self._load_persisted_key()

    def has_image_key(self) -> bool:
        """是否存在可用 AES 密钥（不触发内存扫描）。"""
        with self._key_lock:
            return self._current_aes_key() is not None

    def try_acquire_image_key(self, force: bool = False) -> bool:
        """有界获取图片 AES 密钥；命中后持久化。供后台密钥服务周期调用。

        未命中进入 ``scan_cooldown_seconds`` 冷却期，期间直接返回 False，
        避免对多 GB 内存的微信进程反复全量扫描。``force=True`` 绕过冷却。
        """
        with self._key_lock:
            if self._current_aes_key() is not None:
                self._last_scan_miss = None
                return True
            if (
                not force
                and self._last_scan_miss is not None
                and time.monotonic() - self._last_scan_miss
                < self._scan_cooldown
            ):
                return False
            key = self._scan_aes_key(
                deadline=time.monotonic() + self._scan_budget
            )
            if key:
                self._persist_key(key)
                self._last_scan_miss = None
                return True
            self._last_scan_miss = time.monotonic()
            return False

    def refresh_image_key(self) -> bool:
        """显式刷新：清运行缓存/探针缓存/冷却标记后强制重扫。

        账号切换后调用：探针随新账号的 .dat 重新取样，旧账号密钥校验
        自然失效，新密钥按账号持久化。
        """
        with self._key_lock:
            self._img_key = None
            self._key_probe = None
            self._last_scan_miss = None
            return self.try_acquire_image_key(force=True)

    def detect_image_key(self, refresh: bool = False,
                         wait_seconds: float = 120.0
                         ) -> Optional[Tuple[str, int]]:
        """交互/CLI 入口：返回 (AES 密钥, XOR 密钥)；失败返回 None。

        密钥来源优先级：显式注入 image_key → 本地缓存 → 进程内存扫描。
        扫描未命中且 ``wait_seconds > 0`` 时轮询等待（提示用户去微信
        点开一张图片看大图），命中后持久化。Channel Host 请求路径
        不得调用本方法（会阻塞），请使用后台密钥服务。
        """
        with self._key_lock:
            if self._img_key and not refresh:
                return self._img_key
            probe = self._probe_ct()
            if not probe:
                return None
            dat = self._dbg_last_dat()
            xor_key = self._derive_xor_key(dat) if dat else 0x88
            aes_key = self._current_aes_key()
            if not aes_key:
                if wait_seconds > 0:
                    print(
                        "未在微信进程内存中找到图片 AES 密钥。\n"
                        "请现在打开微信，进入任意聊天，点击一张图片查看大图，\n"
                        f"本程序将在 {wait_seconds:.0f} 秒内自动捕获密钥..."
                    )
                start = time.time()
                while True:
                    aes_key = self._scan_aes_key(
                        deadline=time.monotonic() + self._scan_budget
                    )
                    if aes_key:
                        self._persist_key(aes_key)
                        break
                    if time.time() - start >= wait_seconds:
                        break
                    time.sleep(2.0)
            if not aes_key:
                return None
            self._img_key = (aes_key, xor_key)
            return self._img_key

    def _dbg_last_dat(self) -> str:
        base = os.path.join(self.db.account_dir, "msg", "attach")
        hits = glob.glob(os.path.join(base, "*", "*", "Img", "*.dat"))
        return sorted(hits, key=os.path.getmtime)[-1] if hits else ""

    # ------------------------------------------------------------------
    # 图片解密
    # ------------------------------------------------------------------
    def decrypt_image(self, dat_path: str, aes_key: Optional[str] = None,
                      xor_key: Optional[int] = None,
                      allow_key_scan: bool = True) -> bytes:
        """解密单个 .dat 为图片字节（自动识别 v1/v2 格式）

        ``allow_key_scan=False``：缺 AES 密钥时立即 RuntimeError，不做
        进程内存扫描（Channel Host 请求路径语义）。
        """
        with open(dat_path, "rb") as f:
            data = f.read()
        if not data:
            raise ValueError("空文件: %s" % dat_path)
        magic = data[:6]
        if magic == V2_MAGIC:
            return self._decrypt_v2(
                data, dat_path, aes_key, xor_key, allow_key_scan=allow_key_scan
            )
        if magic == V1_MAGIC:
            if xor_key is None:
                xor_key = self._derive_xor_key(dat_path)
            key = data[6:22]
            body = data[22:]
            return bytes(b ^ (xor_key & 0xFF) for b in body)
        # 早期纯异或格式：逐字节 ^ 0xFF（无签名），按 JPEG/PNG 魔数回退判断
        for cand in (0x88, 0x30, 0xFF, 0xE9):
            out = bytes(b ^ cand for b in data)
            if out[:3] == b"\xff\xd8\xff" or out[:4] == b"\x89PNG":
                return out
        raise ValueError("无法识别的图片加密格式: %s" % dat_path)

    def _resolve_aes_key(self, allow_scan: bool = True) -> Optional[str]:
        """统一密钥解析：显式注入 → 本地缓存 → （可选）有界内存扫描。

        ``allow_scan=False`` 供 Channel Host 请求路径使用：缺密钥立即返回
        None（上层转为 RuntimeError → pending），绝不阻塞 HTTP worker。
        扫描未命中进入冷却期，冷却期内直接放弃，由后台密钥服务负责重试。
        """
        with self._key_lock:
            current = self._current_aes_key()
            if current:
                return current
            if not allow_scan:
                return None
            if (
                self._last_scan_miss is not None
                and time.monotonic() - self._last_scan_miss
                < self._scan_cooldown
            ):
                return None
            key = self._scan_aes_key(
                deadline=time.monotonic() + self._scan_budget
            )
            if key:
                self._persist_key(key)
                self._last_scan_miss = None
            else:
                self._last_scan_miss = time.monotonic()
            return key

    def _decrypt_v2(self, data: bytes, dat_path: str,
                    aes_key: Optional[str], xor_key: Optional[int],
                    allow_key_scan: bool = True) -> bytes:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        aes_size, xor_size = struct.unpack_from("<LL", data, 6)
        if xor_key is None:
            xor_key = self._derive_xor_key(dat_path)
        if aes_key is None:
            aes_key = self._resolve_aes_key(allow_scan=allow_key_scan)
            if not aes_key:
                raise RuntimeError(
                    "无法获取图片 AES 密钥：请保持微信登录，并先在微信聊天中"
                    "打开（点击查看大图）任意一张图片，再重试 detect_image_key()；"
                    "或通过 MediaDownloader(image_key='...') 手动传入密钥。"
                )
        aes_blk = aligned_aes_block_size(aes_size)
        off = 15
        aes_data = data[off: off + aes_blk]
        off += aes_blk
        raw_data = data[off: len(data) - xor_size]
        xor_data = data[len(data) - xor_size:]
        dec = Cipher(algorithms.AES(aes_key.encode()), modes.ECB()).decryptor()
        pt = dec.update(aes_data) + dec.finalize()
        pad = pt[-1] if pt else 0
        if 1 <= pad <= 16 and all(b == pad for b in pt[-pad:]):
            pt = pt[:-pad]
        return pt + raw_data + bytes(b ^ (xor_key & 0xFF) for b in xor_data)

    # ------------------------------------------------------------------
    # 定位本地文件
    # ------------------------------------------------------------------
    def _chat_md5(self, user: str) -> str:
        import hashlib
        return hashlib.md5(user.encode()).hexdigest()

    def _month_of(self, create_time: int) -> str:
        return time.strftime("%Y-%m", time.localtime(create_time))

    def _find_dat(self, user: str, md5: str, create_time: int) -> Optional[str]:
        base = os.path.join(self.db.account_dir, "msg", "attach", self._chat_md5(user))
        for root, _, files in os.walk(base):
            for f in files:
                if f == md5 + ".dat":
                    return os.path.join(root, f)
        return None

    # ------------------------------------------------------------------
    # 各类媒体下载
    # ------------------------------------------------------------------
    def _out(self, save_dir: Optional[str], name: str) -> str:
        d = save_dir or self.save_dir
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, name)

    def _img_md5(self, row: dict) -> Optional[str]:
        pi = row.get("packed_info")
        content = row.get("content")
        for blob in (pi, content):
            if isinstance(blob, bytes):
                m = re.search(rb"([0-9a-fA-F]{32})", blob)
                if m:
                    return m.group(1).decode().lower()
        return None

    def download_image(self, user: str, local_id: int, save_dir: Optional[str] = None,
                       aes_key: Optional[str] = None, xor_key: Optional[int] = None,
                       allow_key_scan: bool = True) -> Optional[str]:
        """下载图片消息并解密为 jpg/png/gif，返回落盘路径"""
        row = self.db.get_message_row(user, local_id)
        if not row or row["local_type"] != 3:
            return None
        md5 = self._img_md5(row)
        if not md5:
            return None
        dat_path = self._find_dat(user, md5, row["create_time"])
        if not dat_path:
            return None
        data = self.decrypt_image(dat_path, aes_key, xor_key, allow_key_scan)
        if data[:3] == b"\xff\xd8\xff":
            ext = "jpg"
        elif data[:4] == b"\x89PNG":
            ext = "png"
        elif data[:3] == b"GIF":
            ext = "gif"
        elif data[:4] == b"wxgf":
            # 微信动画表情容器：不是可查看的图片，不落盘为伪 .gif
            return None
        else:
            ext = "img"
        out = self._out(save_dir, "%s_%s.%s" % (user, local_id, ext))
        with open(out, "wb") as f:
            f.write(data)
        return out

    # ------------------------------------------------------------------
    # 缩略图回退（免 AES 密钥）
    # ------------------------------------------------------------------
    def _find_thumbnail_dat(self, md5: str) -> Optional[str]:
        base = os.path.join(self.db.account_dir, "msg", "attach")
        hits = glob.glob(os.path.join(base, "**", md5 + "_t.dat"),
                         recursive=True)
        return hits[0] if hits else None

    def _decrypt_thumbnail_bytes(self, dat_path: str) -> Optional[bytes]:
        """缩略图解密：整文件 XOR（尾部 FFD9 反推）优先，失败回退常规解密。

        缩略图不依赖 AES 密钥；本方法绝不触发进程内存扫描。
        """
        try:
            with open(dat_path, "rb") as f:
                data = f.read()
        except OSError:
            return None
        if not data:
            return None
        tail = data[-2:]
        if len(tail) == 2:
            key = tail[0] ^ 0xFF
            if tail[1] ^ 0xD9 == key:
                out = bytes(b ^ key for b in data)
                if _jpeg_like(out):
                    return out
        try:
            out = self.decrypt_image(dat_path, allow_key_scan=False)
        except (ValueError, OSError, RuntimeError):
            return None
        return out if _jpeg_like(out) else None

    def download_image_thumbnail(self, user: str, local_id: int,
                                 save_dir: Optional[str] = None
                                 ) -> Optional[str]:
        """下载图片消息的缩略图（免 AES 密钥），返回落盘路径。

        原图密钥缺失或原图未落地时，Channel Host 用本方法保证图片仍可
        显示。不可用（无文件/无法解密/wxgf 容器）返回 None。
        """
        row = self.db.get_message_row(user, local_id)
        if not row or row["local_type"] != 3:
            return None
        md5 = self._img_md5(row)
        if not md5:
            return None
        dat_path = self._find_thumbnail_dat(md5)
        if not dat_path:
            return None
        data = self._decrypt_thumbnail_bytes(dat_path)
        if data is None:
            return None
        if data[:3] == b"\xff\xd8\xff":
            ext = "jpg"
        elif data[:4] == b"\x89PNG":
            ext = "png"
        elif data[:3] == b"GIF":
            ext = "gif"
        else:
            return None  # wxgf 等容器不是可显示图片
        out = self._out(save_dir, "%s_%s_thumb.%s" % (user, local_id, ext))
        with open(out, "wb") as f:
            f.write(data)
        return out

    def download_voice(self, user: str, local_id: int, save_dir: Optional[str] = None) -> Optional[str]:
        """语音：media_0.db VoiceInfo.voice_data（SILK 二进制），落盘 .silk"""
        row = self.db.get_message_row(user, local_id)
        if not row or row["local_type"] != 34 or not row["server_id"]:
            return None
        for rel, path, _ in self.db._db_files:
            if os.path.basename(path) != "media_0.db":
                continue
            conn = self.db._open(rel)
            try:
                cid = conn.execute(
                    "SELECT rowid FROM Name2Id WHERE user_name=?", (user,)
                ).fetchone()
                chat_id = cid[0] if cid else None
                if chat_id is None:
                    return None
                v = conn.execute(
                    "SELECT voice_data FROM VoiceInfo WHERE chat_name_id=? AND svr_id=? "
                    "ORDER BY create_time DESC LIMIT 1",
                    (chat_id, row["server_id"]),
                ).fetchone()
            finally:
                conn.close()
            if v and v["voice_data"]:
                out = self._out(save_dir, "%s_%s.silk" % (user, local_id))
                with open(out, "wb") as f:
                    f.write(v["voice_data"])
                return out
            break
        return None

    def download_video(self, user: str, local_id: int, save_dir: Optional[str] = None) -> Optional[str]:
        """视频：按 packed_info 中的 id 在 msg/video 下查找 <id>.mp4"""
        row = self.db.get_message_row(user, local_id)
        if not row or row["local_type"] != 43:
            return None
        pi = row.get("packed_info")
        if not isinstance(pi, bytes):
            return None
        m = re.search(rb"([0-9a-fA-F]{32})", pi)
        vid = m.group(1).decode().lower() if m else None
        base = os.path.join(self.db.account_dir, "msg", "video")
        for root, _, files in os.walk(base):
            for f in files:
                if vid and f == vid + ".mp4":
                    out = self._out(save_dir, "%s_%s.mp4" % (user, local_id))
                    with open(out, "wb") as w:
                        with open(os.path.join(root, f), "rb") as r:
                            w.write(r.read())
                    return out
        return None

    def _file_name(self, row: dict) -> Optional[str]:
        if not row["server_id"]:
            return None
        for rel, path, _ in self.db._db_files:
            if os.path.basename(path) != "message_resource.db":
                continue
            conn = self.db._open(rel)
            try:
                r = conn.execute(
                    "SELECT d.packed_info FROM MessageResourceDetail d "
                    "LEFT JOIN MessageResourceInfo i ON d.message_id=i.message_id "
                    "WHERE i.message_svr_id=? LIMIT 1",
                    (row["server_id"],),
                ).fetchone()
            finally:
                conn.close()
            if r and r["packed_info"]:
                names = _extract_packed_info_strings(r["packed_info"])
                for raw_name in reversed(names):
                    name = raw_name.strip().replace("\\", "/")
                    if "/" in name:
                        name = name.rsplit("/", 1)[-1]
                    if name:
                        return name
                return None
            break
        return None

    def download_file(self, user: str, local_id: int, save_dir: Optional[str] = None) -> Optional[str]:
        """文件：msg/file/<YYYY-MM>/<原文件名>，原文件名来自 message_resource"""
        row = self.db.get_message_row(user, local_id)
        if not row:
            return None
        type_name = self.db._msg_type_name(row["local_type"]) if hasattr(
            self.db, "_msg_type_name"
        ) else None
        if row["local_type"] != 49 and type_name != "文件/链接/卡片":
            return None
        name = self._file_name(row)
        if not name:
            return None
        base = os.path.join(self.db.account_dir, "msg", "file")
        for root, _, files in os.walk(base):
            for f in files:
                if f == name:
                    out = self._out(save_dir, "%s_%s_%s" % (user, local_id, name))
                    with open(out, "wb") as w:
                        with open(os.path.join(root, f), "rb") as r:
                            w.write(r.read())
                    return out
        return None

    def download_media(self, user: str, local_id: int, save_dir: Optional[str] = None) -> Optional[str]:
        """按消息类型自动分发：3 图片 / 34 语音 / 43 视频 / 49 文件"""
        row = self.db.get_message_row(user, local_id)
        if not row:
            return None
        t = row["local_type"]
        if t == 3:
            return self.download_image(user, local_id, save_dir)
        if t == 34:
            return self.download_voice(user, local_id, save_dir)
        if t == 43:
            return self.download_video(user, local_id, save_dir)
        if t == 49:
            return self.download_file(user, local_id, save_dir)
        return None


def _read_varint(data: bytes, index: int):
    value = 0
    shift = 0
    while index < len(data):
        byte = data[index]
        index += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            break
        shift += 7
    return value, index


def _extract_packed_info_strings(packed_info: bytes) -> list[str]:
    """从微信 MessageResourceDetail.packed_info 中提取 UTF-8 文件名字符串。

    该字段是若干嵌套 length-delimited 的类似 Protobuf 消息；文件名通常位于
    字段号 2（0x12）。解析失败时返回空列表，由调用方保持旧的安全降级。
    """
    strings: list[str] = []
    index = 0
    while index < len(packed_info):
        tag = packed_info[index]
        index += 1
        wire = tag & 0x07
        if wire == 2:
            length, index = _read_varint(packed_info, index)
            payload = packed_info[index : index + length]
            index += length
            if tag == 0x0A:
                strings.extend(_extract_packed_info_strings(payload))
            elif tag == 0x12:
                try:
                    strings.append(payload.decode("utf-8"))
                except UnicodeDecodeError:
                    continue
        elif wire == 0:
            _value, index = _read_varint(packed_info, index)
        elif wire == 1:
            index += 8
        elif wire == 5:
            index += 4
        else:
            index += 1
    return strings
