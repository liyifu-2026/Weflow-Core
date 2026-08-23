# -*- coding: utf-8 -*-
"""wechatauto 数据库读取模块（微信 4.x）

通过读取微信本地 SQLCipher 加密数据库实现消息读取，不依赖 UI 自动化。

原理：
    1. 从微信配置文件（%APPDATA%/Tencent/xwechat/config/*.ini）定位数据目录；
    2. 从 Weixin.exe 进程内存中只读扫描 ``com.Tencent.WCDB.Config.Cipher``
       配置对象，提取每个数据库独立的 32 字节密钥（SQLCipher 4 格式，
       PBKDF2-HMAC-SHA512, 256000 迭代）；
    3. 按页解密数据库到临时目录（带缓存），再用标准 sqlite3 查询。

限制：
    - 微信必须处于登录状态（密钥存在于进程内存中，首次提取后本地缓存）；
    - 合并 -wal 时若微信正在 checkpoint，可能触发一次全量重建重试；
    - 仅支持读取，不支持发送。
"""

from __future__ import annotations

import ctypes
import glob
import hashlib
import hmac as hmac_mod
import json
import os
import queue
import re
import shutil
import sqlite3
import struct
import sys
import tempfile
import threading
import time
from ctypes import wintypes
from typing import Dict, List, Optional, Tuple

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PAGE_SZ = 4096
RESERVE_SZ = 80  # IV(16) + HMAC(64)
STAMP_VERSION = 2  # 解密缓存 stamp 格式版本，改合并逻辑时递增以强制重建
CONFIG_CIPHER_NAME = b"com.Tencent.WCDB.Config.Cipher"
CONFIG_XOR_MASK = bytes.fromhex(
    "d2c7442458020000004889442450488b"
    "450048844c2448488944254048584c24"
)
HEX_LITERAL_RE = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")

MSG_TYPE_NAMES = {
    1: "文本",
    3: "图片",
    34: "语音",
    43: "视频",
    47: "动画表情",
    48: "位置",
    49: "文件/链接/卡片",
    10000: "系统消息",
}


class _MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("__alignment1", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("__alignment2", wintypes.DWORD),
    ]


_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_k32.VirtualQueryEx.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(_MBI), ctypes.c_size_t,
]
_k32.VirtualQueryEx.restype = ctypes.c_size_t
_k32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]


def _md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def _pbkdf2(passwd: bytes, salt: bytes, iters: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", passwd, salt, iters, dklen=32)


def _aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    return dec.update(data) + dec.finalize()


def _verify_enc_key(enc_key: bytes, page1: bytes) -> bool:
    if len(page1) < PAGE_SZ:
        return False
    salt = page1[:16]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = _pbkdf2(enc_key, mac_salt, 2)
    hmac_data = page1[16: PAGE_SZ - RESERVE_SZ + 16]
    stored_hmac = page1[PAGE_SZ - 64: PAGE_SZ]
    hm = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    hm.update(struct.pack("<I", 1))
    return hm.digest() == stored_hmac


def _sqlite_text_factory(data: bytes):
    """sqlite TEXT 列解码：合法 UTF-8 返回 str，否则原样返回 bytes（图片等二进制内容）"""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data


def _decrypt_page(enc_key: bytes, page: bytes, pgno: int) -> bytes:
    iv = page[PAGE_SZ - RESERVE_SZ: PAGE_SZ - RESERVE_SZ + 16]
    if pgno == 1:
        enc = page[16: PAGE_SZ - RESERVE_SZ]
        return b"SQLite format 3\x00" + _aes_cbc_decrypt(enc_key, iv, enc) + b"\x00" * RESERVE_SZ
    enc = page[: PAGE_SZ - RESERVE_SZ]
    return _aes_cbc_decrypt(enc_key, iv, enc) + b"\x00" * RESERVE_SZ


def _extract_text_from_blob(content: bytes) -> Optional[str]:
    """从微信消息容器头中还原 UTF-8 明文文本。

    微信 4.x 部分文本消息的 message_content 为「容器头(0x28 b5 2f fd...)
    + UTF-8 明文 + 尾部填充(\x01\x00...)」，多数消息明文从第 10 字节开始；
    长消息可能加密，无法还原返回 None。
    """
    def _try_off(off: int) -> Optional[str]:
        if off >= len(content):
            return None
        chunk = content[off:]
        if b"\x01\x00" in chunk:
            chunk = chunk.split(b"\x01\x00")[0]
        try:
            t = chunk.decode("utf-8")
        except UnicodeDecodeError:
            return None
        t = re.sub(r"[\x00-\x1f\x7f]+", "", t).strip()
        if not t:
            return None
        if not re.search(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]", t):
            return None
        printable = sum(1 for ch in t if ch.isprintable())
        if printable / len(t) < 0.6:
            return None
        return t

    t = _try_off(10)
    if t:
        return t
    for off in range(0, min(16, len(content))):
        if off == 10:
            continue
        t = _try_off(off)
        if t:
            return t
    return None


class WeChatDB:
    """微信 4.x 本地数据库读取器"""

    def __init__(
        self,
        db_dir: Optional[str] = None,
        keys_file: Optional[str] = None,
        workdir: Optional[str] = None,
        account: Optional[str] = None,
    ):
        self.db_dir = db_dir or auto_detect_db_dir()
        if not self.db_dir:
            raise RuntimeError("未找到微信数据库目录，请通过 db_dir 参数手动指定")
        self.account = account or self._pick_account()
        self.account_dir = os.path.join(self.db_dir, self.account)
        self.workdir = workdir or os.path.join(
            tempfile.gettempdir(), "wechatauto_db", self.account
        )
        self.keys_file = keys_file or os.path.join(self.workdir, "keys.json")
        self._keys: Dict[str, bytes] = {}
        self._db_files = self._collect_db_files()
        self._load_or_extract_keys()

    # ------------------------------------------------------------------
    # 账号与数据库文件
    # ------------------------------------------------------------------
    def _pick_account(self) -> str:
        candidates = []
        for d in glob.glob(os.path.join(self.db_dir, "wxid_*")):
            if os.path.isdir(os.path.join(d, "db_storage")):
                recent = max(
                    (
                        os.path.getmtime(os.path.join(root, f))
                        for root, _, files in os.walk(os.path.join(d, "db_storage"))
                        for f in files
                        if f.endswith(".db") and not f.endswith("-wal")
                    ),
                    default=0,
                )
                candidates.append((recent, os.path.basename(d)))
        if not candidates:
            raise RuntimeError("未找到任何已登录账号的数据库")
        candidates.sort(reverse=True)
        return candidates[0][1]

    def _collect_db_files(self) -> List[Tuple[str, str, int]]:
        files = []
        base = os.path.join(self.account_dir, "db_storage")
        for root, _, names in os.walk(base):
            for name in names:
                if not name.endswith(".db") or name.endswith("-wal") or name.endswith("-shm"):
                    continue
                path = os.path.join(root, name)
                files.append((os.path.relpath(path, base), path, os.path.getsize(path)))
        return files

    @property
    def wxid(self) -> str:
        """当前账号的微信号（去掉目录名末尾的 4 位哈希后缀）"""
        return re.sub(r"_\w{4}$", "", self.account)

    def get_self_info(self) -> dict:
        """当前登录账号的昵称等信息"""
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "contact.db":
                continue
            conn = self._open(rel)
            row = conn.execute(
                "SELECT username, nick_name, remark FROM contact WHERE username=? LIMIT 1",
                (self.wxid,),
            ).fetchone()
            if row:
                return {"username": row[0], "nick_name": row[1], "remark": row[2]}
        return {"username": self.wxid, "nick_name": "", "remark": ""}

    # ------------------------------------------------------------------
    # 密钥提取
    # ------------------------------------------------------------------
    def _load_or_extract_keys(self) -> None:
        if os.path.exists(self.keys_file):
            try:
                with open(self.keys_file, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                for rel, hexkey in saved.items():
                    try:
                        self._keys[rel] = bytes.fromhex(hexkey)
                    except ValueError:
                        pass
            except (json.JSONDecodeError, OSError):
                pass
        missing = [
            rel for rel, path, _ in self._db_files
            if rel not in self._keys or not self._key_works(rel)
        ]
        if missing:
            extracted = self.extract_keys()
            self._keys.update(extracted)
            self._save_keys()
        self.unkeyed = [
            rel for rel, _, _ in self._db_files if not self._key_works(rel)
        ]

    def _key_works(self, rel: str) -> bool:
        key = self._keys.get(rel)
        if not key:
            return False
        path = self._db_path(rel)
        try:
            with open(path, "rb") as f:
                page1 = f.read(PAGE_SZ)
        except OSError:
            return False
        return _verify_enc_key(key, page1)

    def _db_path(self, rel: str) -> str:
        for r, path, _ in self._db_files:
            if r == rel:
                return path
        raise KeyError(rel)

    def extract_keys(self) -> Dict[str, bytes]:
        """从 Weixin.exe 进程内存扫描 Config.Cipher 对象，提取各库密钥"""
        pids = self._find_weixin_pids()
        if not pids:
            raise RuntimeError("未检测到 Weixin.exe，请先登录微信再运行")
        keys: Dict[str, bytes] = {}
        tested: set = set()
        for pid in pids:
            keys.update(self._extract_keys_pid(pid, tested))
            if len(keys) >= len(self._db_files):
                break
        return keys

    def _find_weixin_pids(self) -> List[int]:
        import subprocess

        try:
            r = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
                capture_output=True, text=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            return []
        pids = []
        for line in r.stdout.strip().splitlines():
            parts = line.strip('"').split('","')
            if len(parts) >= 2 and parts[1].isdigit():
                pids.append(int(parts[1]))
        return pids

    def _extract_keys_pid(self, pid: int, tested: set) -> Dict[str, bytes]:
        h = _k32.OpenProcess(0x0010 | 0x0400, False, pid)
        if not h:
            return {}
        try:
            def read(addr: int, n: int):
                buf = ctypes.create_string_buffer(n)
                br = ctypes.c_size_t(0)
                if _k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(br)) and br.value:
                    return buf.raw[: br.value]
                return None

            needles = self._find_bytes(h, read, CONFIG_CIPHER_NAME)
            pairs = [
                struct.pack("<Q", addr) + struct.pack("<Q", len(CONFIG_CIPHER_NAME))
                for addr in needles
            ]
            keys: Dict[str, bytes] = {}
            for pair in pairs:
                for qaddr in self._find_bytes(h, read, pair):
                    node = read(qaddr - 0x10, 0x50)
                    if not node or len(node) < 0x40:
                        continue
                    if struct.unpack_from("<Q", node, 0x10)[0] not in needles:
                        continue
                    if struct.unpack_from("<Q", node, 0x18)[0] != len(CONFIG_CIPHER_NAME):
                        continue
                    config_ptr = struct.unpack_from("<Q", node, 0x28)[0]
                    if not (0x10000 <= config_ptr < 0x800000000000):
                        continue
                    obj = read(config_ptr + 0x88, 0x28)
                    if not obj or len(obj) < 0x18:
                        continue
                    data_ptr = struct.unpack_from("<Q", obj, 0x8)[0]
                    data_len = struct.unpack_from("<Q", obj, 0x10)[0]
                    if not (0 < data_len <= 1024 and 0x10000 <= data_ptr < 0x800000000000):
                        continue
                    blob = read(data_ptr, int(data_len))
                    if not blob or len(blob) != data_len:
                        continue
                    decoded = bytes(
                        v ^ CONFIG_XOR_MASK[i % len(CONFIG_XOR_MASK)]
                        for i, v in enumerate(blob)
                    )
                    for m in HEX_LITERAL_RE.finditer(decoded):
                        run = m.group(1).decode().lower()
                        starts = [0]
                        if len(run) > 96:
                            starts += list(range(0, len(run) - 63, 32))
                            starts.append(len(run) - 64)
                        for s in dict.fromkeys(starts):
                            if s + 64 > len(run):
                                continue
                            cand = bytes.fromhex(run[s:s + 64])
                            if cand in tested or not self._probable_key(cand):
                                continue
                            tested.add(cand)
                            for rel, path, _ in self._db_files:
                                if rel in keys:
                                    continue
                                with open(path, "rb") as f:
                                    page1 = f.read(PAGE_SZ)
                                if _verify_enc_key(cand, page1):
                                    keys[rel] = cand
                                    break
        finally:
            _k32.CloseHandle(h)
        return keys

    @staticmethod
    def _probable_key(b: bytes) -> bool:
        return (
            len(b) == 32
            and len(set(b)) >= 15
            and b not in {b"\x00" * 32, b"\xff" * 32}
        )

    @staticmethod
    def _find_bytes(h, read, needle: bytes) -> List[int]:
        hits = []
        addr = 0
        while True:
            mbi = _MBI()
            r = _k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
            if r == 0:
                break
            if (
                mbi.State == 0x1000
                and (mbi.Protect & 0xFF) & 0xE6
                and not (mbi.Protect & 0x100)
                and 0 < mbi.RegionSize < 0x10000000
            ):
                buf = read(mbi.BaseAddress or 0, mbi.RegionSize)
                if buf:
                    base = mbi.BaseAddress or 0
                    pos = 0
                    while True:
                        pos = buf.find(needle, pos)
                        if pos < 0:
                            break
                        hits.append(base + pos)
                        pos += 1
            addr = (mbi.BaseAddress or 0) + mbi.RegionSize
        return hits

    def _save_keys(self) -> None:
        os.makedirs(os.path.dirname(self.keys_file), exist_ok=True)
        with open(self.keys_file, "w", encoding="utf-8") as f:
            json.dump({k: v.hex() for k, v in self._keys.items()}, f, indent=2)

    # ------------------------------------------------------------------
    # 解密与查询
    # ------------------------------------------------------------------
    WAL_HEADER_SZ = 32   # WCDB WAL 文件头
    WAL_FRAME_SZ = 4120  # 帧头 24 字节(大端 pgno + 校验等) + 4096 加密页

    def _open(self, rel: str) -> sqlite3.Connection:
        """打开解密(并合并 -wal 增量)后的只读库。

        解密结果缓存到 workdir；主库或 WAL 有变化时：
        - 主库被 checkpoint 改写（mtime/size 变化）或 WAL 被重置 → 全量重建；
        - 仅 WAL 追加了新帧 → 增量合并新帧（秒级）。
        """
        if rel not in self._keys:
            raise RuntimeError("数据库无可用密钥: %s" % rel)
        src = self._db_path(rel)
        dst = os.path.join(self.workdir, rel.replace(os.sep, "__"))
        key = self._keys[rel]
        src_mtime = os.path.getmtime(src)
        src_size = os.path.getsize(src)
        wal_path = self._wal_path(rel)
        wal_mtime = os.path.getmtime(wal_path) if wal_path else 0.0
        wal_size = os.path.getsize(wal_path) if wal_path else 0
        stamp = dst + ".stamp"
        old = None
        if os.path.exists(stamp):
            try:
                with open(stamp, "r") as f:
                    parts = f.read().split(",")
                old = {
                    "ver": int(parts[0]),
                    "mtime": float(parts[1]),
                    "size": int(parts[2]),
                    "wal_mtime": float(parts[3]),
                    "wal_size": int(parts[4]),
                    "applied": int(parts[5]),
                }
                if old["ver"] != STAMP_VERSION:
                    old = None
            except (ValueError, OSError, IndexError):
                old = None
        build = (not old or old["mtime"] != src_mtime or old["size"] != src_size
                 or old["wal_mtime"] != wal_mtime or old["wal_size"] != wal_size)
        attempt = 0
        while build:
            attempt += 1
            full = (not old or old["mtime"] != src_mtime or old["size"] != src_size
                    or wal_size < old["wal_size"] or wal_size == 0)
            if full:
                self._decrypt_file(src, dst, key)
                applied = 0
            else:
                applied = old["applied"]
            if wal_path and wal_size > self.WAL_HEADER_SZ:
                applied = self._merge_wal(dst, wal_path, key, applied)
            else:
                applied = 0
            if self._check_merged(dst):
                build = False
                os.makedirs(os.path.dirname(stamp), exist_ok=True)
                with open(stamp, "w") as f:
                    f.write("%d,%f,%d,%f,%d,%d"
                            % (STAMP_VERSION, src_mtime, src_size, wal_mtime, wal_size, applied))
            elif attempt >= 3:
                raise RuntimeError("数据库合并失败(文件被微信并发改写): %s" % rel)
            else:
                old = None  # 合并结果损坏 → 全量重建重试
        conn = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        conn.text_factory = _sqlite_text_factory
        return conn

    @staticmethod
    def _check_merged(dst: str) -> bool:
        try:
            conn = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
            try:
                conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            finally:
                conn.close()
            return True
        except sqlite3.DatabaseError:
            return False

    def _wal_path(self, rel: str) -> Optional[str]:
        wal = self._db_path(rel) + "-wal"
        return wal if os.path.exists(wal) else None

    def _merge_wal(self, dst: str, wal_path: str, key: bytes, from_frame: int) -> int:
        """把 -wal 中的加密帧按页号覆盖进已解密的主库文件，返回已应用帧数。

        帧结构（WCDB，全部大端）：[0:4] 页号, [4:8] 提交标记, [8:16] salt, [16:24] 校验。
        帧内页面与主库页相同加密格式，直接用库密钥解密。
        页 1 帧用页 1 专用布局（数据区 [16:4016]，IV 在 [4016:4032]）解密。

        只合并 salt 与当前 WAL 头一致的帧：微信 checkpoint 会重置 WAL（salt+1 并
        清零写游标），旧世代帧若被合并会用过期页覆盖新数据，造成库损坏。
        """
        if not os.path.exists(dst):
            return 0
        out = open(dst, "r+b")
        try:
            db_pages = (os.path.getsize(dst) + 4095) // PAGE_SZ
            max_pgno = 0
            last = from_frame
            with open(wal_path, "rb") as wal:
                wal_hdr = wal.read(self.WAL_HEADER_SZ)
                wal_salt = wal_hdr[16:24]
                wal_size = os.path.getsize(wal_path)
                n = (wal_size - self.WAL_HEADER_SZ) // self.WAL_FRAME_SZ
                for i in range(from_frame, n):
                    wal.seek(self.WAL_HEADER_SZ + i * self.WAL_FRAME_SZ)
                    hdr = wal.read(24)
                    page = wal.read(PAGE_SZ)
                    if len(page) < PAGE_SZ:
                        break
                    pgno = struct.unpack(">I", hdr[:4])[0]
                    last = i + 1
                    if hdr[8:16] != wal_salt:
                        continue
                    pt = _decrypt_page(key, page, pgno)
                    if pgno == 1:
                        if pt[:16] != b"SQLite format 3\x00":
                            continue
                    elif pt[0] not in (0, 2, 5, 10, 13):
                        continue
                    out.seek((pgno - 1) * PAGE_SZ)
                    out.write(pt)
                    max_pgno = max(max_pgno, pgno)
            out.flush()
            db_pages = (os.path.getsize(dst) + 4095) // PAGE_SZ
            out.seek(0)
            page1 = out.read(PAGE_SZ)
            hdr_pages = struct.unpack(">I", page1[28:32])[0]
            new_pages = max(hdr_pages, max_pgno, db_pages)
            if new_pages != hdr_pages:
                page1 = page1[:28] + struct.pack(">I", new_pages) + page1[32:]
                out.seek(0)
                out.write(page1)
            out.flush()
        finally:
            out.close()
        return last

    def _decrypt_file(self, src: str, dst: str, key: bytes) -> None:
        size = os.path.getsize(src)
        pages = size // PAGE_SZ + (1 if size % PAGE_SZ else 0)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(src, "rb") as fin, open(dst, "wb") as fout:
            for pgno in range(1, pages + 1):
                page = fin.read(PAGE_SZ)
                if not page:
                    break
                if len(page) < PAGE_SZ:
                    page = page + b"\x00" * (PAGE_SZ - len(page))
                fout.write(_decrypt_page(key, page, pgno))

    def _message_dbs(self) -> List[str]:
        return sorted(
            rel for rel, path, _ in self._db_files
            if re.match(r"^message[\\/]message_\d+\.db$", rel.replace(os.sep, "/"))
        )

    def _find_msg_table(self, user: str, conns: List[sqlite3.Connection]) -> Optional[Tuple[sqlite3.Connection, str]]:
        target = "Msg_" + _md5_hex(user.encode())
        latest = None
        for conn in conns:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (target,),
            ).fetchone()
            if row:
                max_row = conn.execute(
                    "SELECT max(sort_seq) FROM %s" % target
                ).fetchone()
                max_seq = max_row[0] if max_row and max_row[0] is not None else -1
                if latest is None or max_seq > latest[0]:
                    latest = (max_seq, conn, target)
        return (latest[1], latest[2]) if latest else None

    def _msg_conn(self, user: str) -> Optional[Tuple[sqlite3.Connection, str]]:
        """打开消息库并定位用户消息表（调用方负责 close 连接）"""
        conns = [self._open(rel) for rel in self._message_dbs()]
        try:
            found = self._find_msg_table(user, conns)
        except Exception:
            for c in conns:
                c.close()
            raise
        if not found:
            for c in conns:
                c.close()
            return None
        for c in conns:
            if c is not found[0]:
                c.close()
        return found

    def get_messages(self, user: str, limit: int = 20, offset: int = 0) -> List[dict]:
        """读取指定会话（微信号/群号）的最近消息"""
        found = self._msg_conn(user)
        if not found:
            return []
        conn, table = found
        try:
            rows = conn.execute(
                "SELECT local_id, local_type, real_sender_id, create_time, "
                "message_content, source, packed_info_data, sort_seq "
                "FROM %s ORDER BY sort_seq DESC LIMIT ? OFFSET ?" % table,
                (limit, offset),
            ).fetchall()
        finally:
            conn.close()
        return [self._msg_row_to_dict(r) for r in rows]

    def get_message_row(self, user: str, local_id: int) -> Optional[dict]:
        """按 local_id 读取一条消息的完整原始字段（媒体下载用，含 server_id/packed_info）"""
        found = self._msg_conn(user)
        if not found:
            return None
        conn, table = found
        try:
            row = conn.execute(
                "SELECT local_id, local_type, server_id, real_sender_id, create_time, "
                "message_content, source, packed_info_data, compress_content, sort_seq "
                "FROM %s WHERE local_id=? LIMIT 1" % table,
                (local_id,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        return {
            "local_id": row["local_id"],
            "local_type": row["local_type"],
            "server_id": row["server_id"],
            "sender_id": row["real_sender_id"],
            "create_time": row["create_time"],
            "content": row["message_content"],
            "source": row["source"],
            "packed_info": row["packed_info_data"],
            "compress_content": row["compress_content"],
            "sort_seq": row["sort_seq"],
        }

    def get_new_messages(self, user: str, since_seq: int = 0, limit: int = 200) -> List[dict]:
        """返回 sort_seq > since_seq 的新消息（升序），供轮询监听使用"""
        found = self._msg_conn(user)
        if not found:
            return []
        conn, table = found
        try:
            rows = conn.execute(
                "SELECT local_id, local_type, real_sender_id, create_time, "
                "message_content, source, packed_info_data, sort_seq "
                "FROM %s WHERE sort_seq > ? ORDER BY sort_seq ASC LIMIT ?" % table,
                (since_seq, limit),
            ).fetchall()
        finally:
            conn.close()
        return [self._msg_row_to_dict(r) for r in rows]

    @staticmethod
    def _msg_row_to_dict(r) -> dict:
        content = r["message_content"]
        mtype = WeChatDB._msg_type_name(r["local_type"])
        if isinstance(content, bytes):
            content = WeChatDB._friendly_content(content, mtype)
        return {
            "local_id": r["local_id"],
            "type": mtype,
            "sender_id": r["real_sender_id"],
            "create_time": r["create_time"],
            "content": content,
            "sort_seq": r["sort_seq"],
        }

    @staticmethod
    def _friendly_content(content: bytes, mtype) -> str:
        if content[:4] == b"\x28\xb5\x2f\xfd":
            decompressed = _decompress_zstandard(content)
            if decompressed:
                try:
                    text = decompressed.decode("utf-8").strip()
                except UnicodeDecodeError:
                    text = ""
                if text:
                    return text
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            if content[:4] == b"\x28\xb5\x2f\xfd":
                text = _extract_text_from_blob(content)
                if text:
                    return text
            if mtype == "图片":
                md5 = re.search(rb'md5="([0-9a-fA-F]{32})"', content)
                if md5:
                    return "[图片 md5=%s]" % md5.group(1).decode()
            return "[%s]" % mtype
        return text.strip() or "[%s]" % mtype

    def get_sessions(self, limit: int = 100) -> List[dict]:
        """会话列表（来自 session.db）"""
        sessions = []
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "session.db":
                continue
            conn = self._open(rel)
            try:
                rows = conn.execute(
                    "SELECT username, unread_count, summary, last_timestamp, "
                    "last_msg_sender, last_sender_display_name "
                    "FROM SessionTable WHERE is_hidden=0 "
                    "ORDER BY sort_timestamp DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            finally:
                conn.close()
            for r in rows:
                sessions.append({
                    "username": r["username"],
                    "unread": r["unread_count"],
                    "summary": r["summary"],
                    "last_time": r["last_timestamp"],
                    "last_sender": r["last_sender_display_name"] or r["last_msg_sender"],
                })
            break
        return sessions

    def search_contact(self, keyword: str) -> List[dict]:
        """按昵称/备注/微信号搜索联系人"""
        results = []
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "contact.db":
                continue
            conn = self._open(rel)
            try:
                rows = conn.execute(
                    "SELECT username, nick_name, remark, alias FROM contact "
                    "WHERE nick_name LIKE ? OR remark LIKE ? OR username LIKE ? "
                    "OR alias LIKE ? LIMIT 50",
                    ("%" + keyword + "%",) * 4,
                ).fetchall()
            finally:
                conn.close()
            for r in rows:
                results.append({
                    "username": r["username"],
                    "nick_name": r["nick_name"],
                    "remark": r["remark"],
                    "alias": r["alias"],
                })
            break
        return results

    def list_contacts(self, after_cursor: str = "", limit: int = 100) -> dict:
        """Return a stable, provider-neutral contact page.

        The username is deliberately kept inside the Driver.  The Channel
        Host exposes it only as the opaque ``contactRef``/cursor pair; Core
        never receives SQL column names or local database paths.
        """
        if limit <= 0 or limit > 500:
            raise ValueError("contact page limit must be between 1 and 500")
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "contact.db":
                continue
            conn = self._open(rel)
            try:
                # WeChat 4.x renamed the contact type column from the older
                # replica fixture's `type` to `local_type`. Keep this schema
                # knowledge inside the Driver; Channel Host/Core only see the
                # provider-neutral contactType string.
                columns = {
                    str(row[1])
                    for row in conn.execute("PRAGMA table_info(contact)").fetchall()
                }
                type_column = (
                    "local_type"
                    if "local_type" in columns
                    else "type"
                    if "type" in columns
                    else None
                )
                type_expression = (
                    f'"{type_column}"' if type_column is not None else "NULL"
                )
                rows = conn.execute(
                    "SELECT username, nick_name, remark, alias, "
                    f"{type_expression} AS contact_type "
                    "FROM contact WHERE username > ? "
                    "ORDER BY username ASC LIMIT ?",
                    (after_cursor, limit),
                ).fetchall()
            finally:
                conn.close()
            contacts = []
            for row in rows:
                username = row[0]
                nickname = row[1] or None
                remark = row[2] or None
                contacts.append(
                    {
                        "contactRef": username,
                        "displayName": remark or nickname or username,
                        "nickname": nickname,
                        "remark": remark,
                        "alias": row[3] or None,
                        "avatarUrl": None,
                        "contactType": str(row[4] or "unknown"),
                    }
                )
            next_cursor = contacts[-1]["contactRef"] if contacts else after_cursor
            return {
                "contacts": contacts,
                "nextCursor": next_cursor,
                "hasMore": len(contacts) == limit,
            }
        return {"contacts": [], "nextCursor": after_cursor, "hasMore": False}

    def get_nickname(self, user: str) -> str:
        """通过微信号查昵称（用于显示）"""
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "contact.db":
                continue
            conn = self._open(rel)
            try:
                row = conn.execute(
                    "SELECT nick_name, remark FROM contact WHERE username=? LIMIT 1",
                    (user,),
                ).fetchone()
            finally:
                conn.close()
            if row:
                return row["remark"] or row["nick_name"] or user
            break
        return user

    # ------------------------------------------------------------------
    # 历史消息全量导出
    # ------------------------------------------------------------------
    def _build_md5_index(self) -> Dict[str, str]:
        """会话 md5 → 用户名 反查表（来自 contact/session）"""
        idx: Dict[str, str] = {}
        for rel, path, _ in self._db_files:
            base = os.path.basename(path)
            if base not in ("contact.db", "session.db"):
                continue
            conn = self._open(rel)
            try:
                if base == "contact.db":
                    rows = conn.execute("SELECT username FROM contact")
                else:
                    rows = conn.execute("SELECT username FROM SessionTable")
                for (u,) in rows:
                    if u:
                        idx.setdefault(_md5_hex(u.encode()), u)
            finally:
                conn.close()
        return idx

    def _nickname_index(self) -> Dict[str, str]:
        idx = {}
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "contact.db":
                continue
            conn = self._open(rel)
            try:
                for u, n, r in conn.execute(
                    "SELECT username, nick_name, remark FROM contact"
                ):
                    idx[u] = r or n or u
            finally:
                conn.close()
            break
        return idx

    def _sender_id_index(self) -> Dict[int, str]:
        """消息表 real_sender_id(数字) → 用户名，来自 message_resource.SenderName2Id"""
        idx: Dict[int, str] = {}
        for rel, path, _ in self._db_files:
            if os.path.basename(path) != "message_resource.db":
                continue
            conn = self._open(rel)
            try:
                for rid, u in conn.execute(
                    "SELECT rowid, user_name FROM SenderName2Id"
                ):
                    if u:
                        idx[int(rid)] = u
            finally:
                conn.close()
            break
        return idx

    def _resolve_sender(self, sender_id, sender_index, nicks, self_nick) -> str:
        if sender_id in (2, "2"):
            return self_nick
        if isinstance(sender_id, int):
            u = sender_index.get(sender_id)
            if u:
                return nicks.get(u, u)
        u = str(sender_id)
        return nicks.get(u, u)

    @staticmethod
    def _msg_type_name(t: int):
        """消息类型显示名；兼容微信 4.x 的资源包装类型（低字节为真实类型）"""
        if t in MSG_TYPE_NAMES:
            return MSG_TYPE_NAMES[t]
        if isinstance(t, int) and t > 0xFFFF and (t & 0xFF) in MSG_TYPE_NAMES:
            return MSG_TYPE_NAMES[t & 0xFF]
        return t

    def _export_row(self, r, mtype_names) -> dict:
        content = r["message_content"]
        mtype = mtype_names.get(r["local_type"], self._msg_type_name(r["local_type"]))
        md5 = None
        if isinstance(content, bytes):
            content = self._friendly_content(content, mtype)
        pi = r["packed_info_data"]
        if pi:
            try:
                md5 = re.search(rb"([0-9a-fA-F]{32})", pi)
                md5 = md5.group(1).decode().lower() if md5 else None
            except TypeError:
                md5 = None
        return {
            "local_id": r["local_id"],
            "type": mtype,
            "type_code": r["local_type"],
            "sender_id": r["real_sender_id"],
            "create_time": r["create_time"],
            "content": content,
            "server_id": r["server_id"],
            "md5": md5,
            "sort_seq": r["sort_seq"],
        }

    def list_message_chats(self) -> List[dict]:
        """所有含消息的会话及其聚合消息 high-water（sort_seq）。"""
        tables: Dict[str, Tuple[int, Optional[int]]] = {}
        for rel in self._message_dbs():
            conn = self._open(rel)
            try:
                rows = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
                )
                for t in rows:
                    key = t[0][4:]
                    try:
                        try:
                            row = conn.execute(
                                "SELECT count(*), max(sort_seq) FROM %s" % t[0]
                            ).fetchone()
                        except sqlite3.DatabaseError:
                            # Preserve discovery for legacy message tables that
                            # do not expose sort_seq; the Host can fall back to
                            # its existing per-conversation high-water read.
                            row = conn.execute(
                                "SELECT count(*) FROM %s" % t[0]
                            ).fetchone()
                            row = (row[0], None)
                        cnt = row[0]
                        max_sort_seq = row[1]
                        previous = tables.get(key)
                        if previous is None:
                            tables[key] = (cnt, max_sort_seq)
                        else:
                            previous_max = previous[1]
                            if previous_max is None:
                                combined_max = max_sort_seq
                            elif max_sort_seq is None:
                                combined_max = previous_max
                            else:
                                combined_max = max(previous_max, max_sort_seq)
                            tables[key] = (
                                previous[0] + cnt,
                                combined_max,
                            )
                    except sqlite3.DatabaseError:
                        continue
            finally:
                conn.close()
        idx = self._build_md5_index()
        nicks = self._nickname_index()
        out = []
        for md5, (cnt, max_sort_seq) in tables.items():
            user = idx.get(md5, md5)
            out.append({
                "md5": md5,
                "username": user,
                "name": nicks.get(user, user),
                "message_count": cnt,
                "max_sort_seq": max_sort_seq,
            })
        out.sort(key=lambda x: -x["message_count"])
        return out

    def export_history(
        self,
        out_path: str,
        fmt: str = "json",
        users: Optional[List[str]] = None,
        limit_per_chat: Optional[int] = None,
        progress: Optional[callable] = None,
    ) -> dict:
        """导出历史消息到 JSON 或 SQLite。

        :param out_path: 输出文件路径（json 或 .db/.sqlite）
        :param fmt: "json" 或 "sqlite"
        :param users: 指定会话（用户名或 md5），None 导出全部
        :param limit_per_chat: 每会话最多导出条数（按 sort_seq 升序保留最新）
        :param progress: 回调 (chat_index, total_chats, chat_name)
        :return: {"chats": n, "messages": total, "out": out_path}
        """
        if fmt not in ("json", "sqlite"):
            raise ValueError("fmt 仅支持 json/sqlite")
        idx = self._build_md5_index()
        nicks = self._nickname_index()
        self_info = self.get_self_info()
        sender_index = self._sender_id_index()
        target_md5s = None
        if users:
            target_md5s = {
                u if re.fullmatch(r"[0-9a-f]{32}", u) else _md5_hex(u.encode())
                for u in users
            }

        # md5 -> [(conn, table), ...] 按消息库聚合（会话跨分库分片）
        buckets: Dict[str, list] = {}
        all_conns: List[sqlite3.Connection] = []
        for rel in self._message_dbs():
            conn = self._open(rel)
            all_conns.append(conn)
            tabs = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
            ).fetchall()
            for (t,) in tabs:
                md5 = t[4:]
                if target_md5s is not None and md5 not in target_md5s:
                    continue
                buckets.setdefault(md5, []).append((conn, t))
        try:
            total = 0
            chat_info = []
            order = sorted(buckets.keys())
            for i, md5 in enumerate(order):
                user = idx.get(md5, md5)
                name = nicks.get(user, user)
                if progress:
                    progress(i, len(order), name)
                rows = []
                for conn, table in buckets[md5]:
                    try:
                        rows += conn.execute(
                            "SELECT local_id, local_type, server_id, real_sender_id, "
                            "create_time, message_content, packed_info_data, sort_seq "
                            "FROM %s" % table
                        ).fetchall()
                    except sqlite3.DatabaseError:
                        continue
                if not rows:
                    continue
                rows.sort(key=lambda r: (r["sort_seq"], r["local_id"]))
                if limit_per_chat:
                    rows = rows[-limit_per_chat:]
                msgs = [
                    dict(
                        self._export_row(r, MSG_TYPE_NAMES),
                        sender_name=self._resolve_sender(
                            r["real_sender_id"], sender_index, nicks,
                            self_info.get("nick_name", "我"),
                        ),
                    )
                    for r in rows
                ]
                total += len(msgs)
                chat_info.append({
                    "md5": md5,
                    "username": user,
                    "name": name,
                    "messages": msgs,
                })
            if fmt == "json":
                payload = {
                    "wxid": self.wxid,
                    "nick_name": self_info.get("nick_name", ""),
                    "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "chats": [],
                    "messages": [],
                }
                for c in chat_info:
                    payload["chats"].append({
                        "md5": c["md5"],
                        "username": c["username"],
                        "name": c["name"],
                        "message_count": len(c["messages"]),
                    })
                    for m in c["messages"]:
                        payload["messages"].append(
                            dict(m, chat=c["username"])
                        )
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=1)
            else:
                conn = sqlite3.connect(out_path)
                try:
                    conn.execute(
                        "CREATE TABLE chats(md5 TEXT PRIMARY KEY, username TEXT, "
                        "name TEXT, message_count INT)"
                    )
                    conn.execute(
                        "CREATE TABLE messages(username TEXT, local_id INT, "
                        "type TEXT, type_code INT, sender_id TEXT, sender_name TEXT, "
                        "create_time INT, content TEXT, server_id INT, md5 TEXT, "
                        "sort_seq INT)"
                    )
                    for c in chat_info:
                        conn.execute(
                            "INSERT INTO chats VALUES(?,?,?,?)",
                            (c["md5"], c["username"], c["name"], len(c["messages"])),
                        )
                        conn.executemany(
                            "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            [(
                                c["username"], m["local_id"], m["type"], m["type_code"],
                                str(m["sender_id"]), m["sender_name"], m["create_time"],
                                m["content"], m["server_id"], m["md5"], m["sort_seq"],
                            ) for m in c["messages"]],
                        )
                    conn.commit()
                finally:
                    conn.close()
            return {"chats": len(chat_info), "messages": total, "out": out_path}
        finally:
            for conn in all_conns:
                try:
                    conn.close()
                except Exception:
                    pass


def _decompress_zstandard(content: bytes) -> Optional[bytes]:
    """Decode WeChat's compressed text container when the optional codec exists."""
    try:
        import zstandard
    except ImportError:
        return None
    try:
        return zstandard.ZstdDecompressor().decompress(content)
    except zstandard.ZstdError:
        return None


def list_accounts(db_dir: Optional[str] = None) -> List[dict]:
    """扫描数据目录下的所有微信账号目录。

    返回: [{"account": "wxid_xxx_abcd", "wxid": "wxid_xxx",
            "path": ..., "last_activity": mtime, "self_nick": 昵称或空}]
    """
    db_dir = db_dir or auto_detect_db_dir()
    if not db_dir:
        return []
    out = []
    for d in sorted(glob.glob(os.path.join(db_dir, "wxid_*"))):
        if not os.path.isdir(os.path.join(d, "db_storage")):
            continue
        recent = max(
            (
                os.path.getmtime(os.path.join(root, f))
                for root, _, files in os.walk(os.path.join(d, "db_storage"))
                for f in files
                if f.endswith(".db") and not f.endswith("-wal")
            ),
            default=0,
        )
        account = os.path.basename(d)
        out.append({
            "account": account,
            "wxid": re.sub(r"_\w{4}$", "", account),
            "path": d,
            "last_activity": recent,
        })
    out.sort(key=lambda x: -x["last_activity"])
    return out


_LISTENER_STOP = object()


class Listener:
    """新消息轮询监听器（只读，基于合并了 -wal 的消息库视图）。

    用法::

        listener = Listener(db, interval=1.0)
        listener.add_listener("filehelper", on_new_msg)
        listener.start()
        ...
        listener.stop()

    watermark 可持久化（json），下次启动不会重复推送。

    回调在独立工作线程中执行：每个被监听对象（会话）对应一条串行工作
    线程，保证同一会话内消息按序处理、不同会话间并行。轮询线程只负责
    读取数据库并分派任务，不会被慢回调（AI 调用/图片识别等）阻塞。
    """

    def __init__(self, db: "WeChatDB", interval: float = 1.0,
                 watermark: Optional[Dict[str, int]] = None):
        self.db = db
        self.interval = interval
        self._watermark: Dict[str, int] = watermark or {}
        self._callbacks: Dict[str, List[callable]] = {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # 每会话一条串行工作线程：跨会话并行 + 会话内保序
        self._worker_queues: Dict[str, queue.Queue] = {}
        self._worker_threads: Dict[str, threading.Thread] = {}
        self._workers_lock = threading.Lock()

    def add_listener(self, user: str, callback: callable) -> None:
        """注册新消息回调：callback(msg: dict, listener)"""
        self._callbacks.setdefault(user, []).append(callback)
        if user not in self._watermark:
            msgs = self.db.get_messages(user, limit=1)
            self._watermark[user] = msgs[0]["sort_seq"] if msgs else 0

    def remove_listener(self, user: str, callback: callable) -> None:
        try:
            self._callbacks[user].remove(callback)
        except (KeyError, ValueError):
            pass

    @property
    def watermark(self) -> Dict[str, int]:
        return dict(self._watermark)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="wxdb-listener", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        with self._workers_lock:
            queues = list(self._worker_queues.values())
            threads = list(self._worker_threads.values())
        for q in queues:
            q.put(_LISTENER_STOP)
        for t in threads:
            t.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._poll_once()
            except Exception as exc:  # 单次轮询失败不终止监听
                sys.stderr.write("listener poll error: %r\n" % exc)
            self._stop.wait(self.interval)

    def _poll_once(self) -> None:
        for user, callbacks in list(self._callbacks.items()):
            since = self._watermark.get(user, 0)
            msgs = self.db.get_new_messages(user, since_seq=since)
            if not msgs:
                continue
            self._watermark[user] = msgs[-1]["sort_seq"]
            if not callbacks:
                continue
            self._dispatch(user, msgs)

    def _dispatch(self, user: str, msgs: List[dict]) -> None:
        """把新消息交给该会话的工作线程处理，不阻塞轮询线程。"""
        with self._workers_lock:
            q = self._worker_queues.get(user)
            if q is None:
                q = queue.Queue()
                self._worker_queues[user] = q
                t = threading.Thread(target=self._worker_run, args=(user,),
                                     name="wxmsg-%s" % user, daemon=True)
                self._worker_threads[user] = t
                t.start()
        cbs = tuple(self._callbacks.get(user, ()))
        for m in msgs:
            q.put((m, cbs))

    def _worker_run(self, user: str) -> None:
        q = self._worker_queues.get(user)
        if q is None:
            return
        while True:
            task = q.get()
            if task is _LISTENER_STOP:
                break
            m, cbs = task
            for cb in cbs:
                try:
                    cb(m, self)
                except Exception as exc:
                    sys.stderr.write("listener callback error: %r\n" % exc)


def _extract_path_from_config(content: str) -> Optional[str]:
    """从配置内容中提取数据目录路径，兼容 JSON 字段 / 纯路径 / 任意文本。

    微信 4.x 不同版本配置文件格式不一：有的是纯路径，有的是 JSON
    （字段如 dataDir / fileSavePath）。这里统一兜底提取第一个 Windows 路径。
    """
    content = (content or "").strip().lstrip("\ufeff")
    if not content:
        return None
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            for key in ("dataDir", "data_dir", "fileSavePath", "savePath",
                        "path", "defaultFileSavePath"):
                v = obj.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, str) and re.match(r"^[A-Za-z]:[\\/]", item):
                    return item
    except Exception:
        pass
    if re.match(r"^[A-Za-z]:[\\/]", content):
        return content
    m = re.search(r"[A-Za-z]:[\\/][^\s\x00-\x1f\"']+", content)
    if m:
        return m.group(0).rstrip("\\/")
    return None


def _config_candidates() -> List[str]:
    """可能的微信 4.x 配置目录（按新旧版本与 32/64 位安装差异）。"""
    out = []
    for env in ("APPDATA", "LOCALAPPDATA"):
        base = os.environ.get(env, "")
        if base:
            out.extend([
                os.path.join(base, "Tencent", "xwechat"),
                os.path.join(base, "Tencent", "xwechat", "config"),
                os.path.join(base, "Tencent", "WeChat"),
            ])
    return out


def _registry_data_dirs() -> List[str]:
    """从注册表读取可能指向数据目录的值（用户自定义保存位置时补充来源）。"""
    import winreg
    dirs = []
    for hive, sub in (
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\xwechat"),
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\xwechat\config"),
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\WeChat"),
    ):
        try:
            key = winreg.OpenKey(hive, sub)
        except OSError:
            continue
        try:
            i = 0
            while True:
                try:
                    name, data, _ = winreg.EnumValue(key, i)
                except OSError:
                    break
                i += 1
                if not isinstance(data, str) or not data.strip():
                    continue
                low = name.lower()
                if "path" in low or "dir" in low or "save" in low:
                    dirs.append(data.strip())
        finally:
            winreg.CloseKey(key)
    return dirs


def _locate_account_root(root: Optional[str]) -> Optional[str]:
    """在候选根目录下定位「包含 wxid_* 账号目录」的目录。

    兼容两种布局：
      <root>/xwechat_files/<wxid>_xxxx/db_storage
      <root>/<wxid>_xxxx/db_storage
    返回的目录即 WeChatDB.db_dir（账号目录的父目录）。
    """
    if not root or not os.path.isdir(root):
        return None
    root = root.rstrip("\\/")
    candidates = [root]
    for name in ("xwechat_files", "WeChat Files", "xwechat_files_data"):
        candidates.append(os.path.join(root, name))
    seen = set()
    for cand in candidates:
        cand = cand.rstrip("\\/")
        if cand in seen or not os.path.isdir(cand):
            continue
        seen.add(cand)
        try:
            dirs = os.listdir(cand)
        except OSError:
            continue
        if any(
            d.startswith("wxid_")
            and os.path.isdir(os.path.join(cand, d, "db_storage"))
            for d in dirs
        ):
            return cand
    return None


def auto_detect_db_dir() -> Optional[str]:
    """自动定位微信 4.x 数据目录（不同电脑存储位置不同）。

    探测顺序：
      1. 微信配置文件（%APPDATA%/%LOCALAPPDATA%，支持 JSON/纯路径/任意文本）；
      2. 注册表；
      3. 常见默认目录（Documents / 用户主目录）。
    """
    # 1) 配置文件
    for cfg_dir in _config_candidates():
        if not os.path.isdir(cfg_dir):
            continue
        for fp in glob.glob(os.path.join(cfg_dir, "*")):
            if os.path.isdir(fp):
                continue
            try:
                raw = open(fp, "r", encoding="utf-8").read(8192)
            except (UnicodeDecodeError, OSError):
                try:
                    raw = open(fp, "r", encoding="gbk").read(8192)
                except (UnicodeDecodeError, OSError):
                    continue
            path = _extract_path_from_config(raw)
            if not path:
                continue
            hit = _locate_account_root(path)
            if hit:
                return hit
    # 2) 注册表
    for p in _registry_data_dirs():
        hit = _locate_account_root(p)
        if hit:
            return hit
    # 3) 常见默认目录兜底
    userprofile = os.environ.get("USERPROFILE", "")
    for base in (os.path.join(userprofile, "Documents"), userprofile):
        hit = _locate_account_root(base)
        if hit:
            return hit
    return None
