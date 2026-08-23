# -*- coding: utf-8 -*-
"""图片 AES 密钥管理与缩略图回退的单元测试。

全部使用桩替身，不触碰真实微信进程与 SQLCipher 数据库。
"""

import glob
import hashlib
import json
import os
import tempfile
import time
import unittest

from wechatauto.media import (
    V2_MAGIC,
    MediaDownloader,
    aligned_aes_block_size,
)

XOR_KEY = 0x5A
JPEG_HEAD = b"\xff\xd8\xff\xe0" + b"\x00" * 20
JPEG_TAIL = b"\xff\xd9"


class FakeDB:
    def __init__(self, workdir, account="wxid_demo"):
        self.workdir = workdir
        self.account = account
        self.account_dir = os.path.join(workdir, "account")
        self._db_files = []
        self.rows = {}

    def get_message_row(self, user, local_id):
        return self.rows.get((user, local_id))


def xor_bytes(data: bytes) -> bytes:
    return bytes(b ^ XOR_KEY for b in data)


def write_attach_file(account_dir, user, md5, payload, suffix=".dat"):
    chat_md5 = hashlib.md5(user.encode()).hexdigest()
    month = time.strftime("%Y-%m")
    directory = os.path.join(
        account_dir, "msg", "attach", chat_md5, month, "Img"
    )
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, md5 + suffix)
    with open(path, "wb") as handle:
        handle.write(payload)
    return path


class KeyManagementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeDB(self.tmp.name)

    def downloader(self, **kwargs):
        downloader = MediaDownloader(self.db, **kwargs)
        downloader._probe_ct = lambda *a, **k: b"0123456789abcdef"
        # 桩化密钥反测：16 位以上字符串一律视为有效（真实实现需 AES 解密）
        downloader._validate_key = (
            lambda key: isinstance(key, str) and len(key) >= 16
        )
        return downloader

    def test_scan_miss_enters_cooldown_until_force(self):
        downloader = self.downloader()
        scans = []

        def fake_scan(deadline=None):
            scans.append(deadline)
            return None

        downloader._scan_aes_key = fake_scan
        self.assertFalse(downloader.try_acquire_image_key())
        self.assertFalse(downloader.try_acquire_image_key())
        self.assertEqual(len(scans), 1, "冷却期内不得重复扫描")
        self.assertFalse(downloader.try_acquire_image_key(force=True))
        self.assertEqual(len(scans), 2, "force 必须绕过冷却")

    def test_scan_hit_persists_and_short_circuits(self):
        downloader = self.downloader()
        scans = []
        downloader._scan_aes_key = lambda deadline=None: (
            scans.append(deadline),
            "k" * 16,
        )[1]
        self.assertTrue(downloader.try_acquire_image_key())
        self.assertTrue(downloader.try_acquire_image_key())
        self.assertEqual(len(scans), 1, "命中后走缓存/持久化，不再扫描")
        store = os.path.join(self.tmp.name, "image_keys.json")
        with open(store, "r", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["wxid_demo"], "k" * 16)

    def test_refresh_forces_rescan_within_cooldown(self):
        downloader = self.downloader()
        scans = []
        state = {"key": None}

        def fake_scan(deadline=None):
            scans.append(deadline)
            return state["key"]

        downloader._scan_aes_key = fake_scan
        self.assertFalse(downloader.try_acquire_image_key())
        self.assertFalse(downloader.try_acquire_image_key())
        state["key"] = "n" * 16
        self.assertTrue(downloader.refresh_image_key())
        self.assertEqual(len(scans), 2, "force 必须绕过冷却强制重扫")

    def test_refresh_clears_probe_cache(self):
        payload = b"\x01" * 64
        path = write_attach_file(
            self.db.account_dir, "friend", "a" * 32, payload
        )
        downloader = MediaDownloader(self.db)
        first = downloader._probe_ct(path)
        self.assertTrue(first)
        os.remove(path)
        downloader.refresh_image_key()
        self.assertIsNone(downloader._key_probe)
        self.assertEqual(downloader._probe_ct(), b"")

    def test_has_image_key_does_not_scan(self):
        downloader = self.downloader()

        def forbidden(deadline=None):
            raise AssertionError("has_image_key 不得触发内存扫描")

        downloader._scan_aes_key = forbidden
        self.assertFalse(downloader.has_image_key())

    def test_keys_file_override_path(self):
        custom_dir = os.path.join(self.tmp.name, "custom")
        store = os.path.join(custom_dir, "keys.json")
        downloader = self.downloader(keys_file=store)
        downloader._validate_key = lambda key: True
        downloader._persist_key("z" * 16)
        self.assertTrue(os.path.isfile(store))

    def test_request_path_without_scan_fails_fast(self):
        """allow_key_scan=False 时缺密钥必须立刻 RuntimeError，不扫描内存。"""
        import struct

        user = "friend"
        md5 = "b" * 32
        # V2 格式：AES 段必须依赖密钥；头部只需可解析出 aes/xor 尺寸
        payload = (
            V2_MAGIC
            + struct.pack("<LL", 32, 8)
            + b"\x00"  # pad
            + b"\x11" * aligned_aes_block_size(32)
            + b"\x22" * 16
            + xor_bytes(b"\x00" * 8)  # xor 段占位
        )
        write_attach_file(self.db.account_dir, user, md5, payload)
        self.db.rows[(user, 11)] = {
            "local_id": 11,
            "local_type": 3,
            "server_id": 100,
            "create_time": int(time.time()),
            "packed_info": md5.encode(),
            "content": b"",
        }
        downloader = self.downloader()

        def forbidden(deadline=None):
            raise AssertionError("请求路径不得触发内存扫描")

        downloader._scan_aes_key = forbidden
        with self.assertRaises(RuntimeError):
            downloader.download_image(user, 11, save_dir=self.tmp.name,
                                      allow_key_scan=False)


class ThumbnailFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeDB(self.tmp.name)
        self.user = "friend"
        self.md5 = "c" * 32
        self.db.rows[(self.user, 7)] = {
            "local_id": 7,
            "local_type": 3,
            "server_id": 101,
            "create_time": int(time.time()),
            "packed_info": self.md5.encode(),
            "content": b"",
        }

    def test_thumbnail_whole_file_xor_decrypts_without_aes(self):
        plain = JPEG_HEAD + b"\xab" * 48 + JPEG_TAIL
        write_attach_file(
            self.db.account_dir,
            self.user,
            self.md5,
            xor_bytes(plain),
            suffix="_t.dat",
        )
        downloader = MediaDownloader(self.db)

        def forbidden(deadline=None):
            raise AssertionError("缩略图解密不得触发内存扫描")

        downloader._scan_aes_key = forbidden
        out = downloader.download_image_thumbnail(self.user, 7)
        self.assertIsNotNone(out)
        self.assertTrue(out.endswith("_thumb.jpg"))
        with open(out, "rb") as handle:
            self.assertTrue(handle.read().startswith(b"\xff\xd8\xff"))

    def test_thumbnail_missing_returns_none(self):
        downloader = MediaDownloader(self.db)
        self.assertIsNone(downloader.download_image_thumbnail(self.user, 7))

    def test_thumbnail_wxgf_container_returns_none(self):
        plain = b"wxgf" + b"\x00" * 32 + JPEG_TAIL
        write_attach_file(
            self.db.account_dir,
            self.user,
            self.md5,
            xor_bytes(plain),
            suffix="_t.dat",
        )
        downloader = MediaDownloader(self.db)
        self.assertIsNone(downloader.download_image_thumbnail(self.user, 7))


if __name__ == "__main__":
    unittest.main()
