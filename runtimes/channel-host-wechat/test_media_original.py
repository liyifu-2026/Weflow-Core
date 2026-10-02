"""download_image_original 可离线验证的部分：

- _image_files：三档副本定位（original = ``_h.dat``，即点击「图片原始大小」
  后微信落地的高清文件；v1.2.4.3 同步后原 ``_find_h_dat`` 并入 tier 查询）；
- _save_image_bytes：魔数 → 扩展名落盘、wxgf 容器 ffmpeg 转码回退、
  不可转码的 wxgf 拒绝落盘；
- download_image_original 的前置校验分支（非图片消息/无 md5 提前返回，
  不触碰 UI 自动化）与「本机已有原件直接解密」快速路径（_harvest）。

UI 点击主流程依赖真实微信窗口，不在单测覆盖范围。
"""

import os
import tempfile
import unittest
from pathlib import Path

from wechatauto.media import MediaDownloader


class _DbStub:
    """提供 account_dir 与 get_message_row 的最小桩。"""

    def __init__(self, account_dir: str, row=None):
        self.account_dir = account_dir
        self._row = row

    def get_message_row(self, user, local_id, local_type=None):
        # local_type 关键字为上游 1.2.4.3 的 download_image_original 所加
        return self._row


def _downloader(account_dir: str, row=None) -> MediaDownloader:
    # 不调用 __init__：无需真实微信数据目录与密钥
    md = object.__new__(MediaDownloader)
    md.db = _DbStub(account_dir, row)
    md.save_dir = os.path.join(account_dir, "out")
    return md


def _image_row(local_id=5, create_time=1756600000, packed_info=b""):
    return {
        "local_id": local_id,
        "local_type": 3,
        "server_id": 9001,
        "sender_id": "wxid_x",
        "create_time": create_time,
        "content": b"md5=\"%s\"" % b"0" * 32,
        "source": None,
        "packed_info": packed_info,
        "compress_content": None,
        "sort_seq": local_id,
    }


def _attach_dir(directory: str, user: str) -> Path:
    """msg/attach/<chat_md5(user)>：目录名用被测代码自己的 _chat_md5 计算。"""
    md = _downloader(directory)
    return Path(directory) / "msg" / "attach" / md._chat_md5(user)


class ImageFilesTest(unittest.TestCase):
    """_image_files：一次目录扫描给出三档副本（v1.2.4.3 tier API）。"""

    def test_finds_h_dat_under_attach(self):
        with tempfile.TemporaryDirectory() as directory:
            base = _attach_dir(directory, "user") / "2026-08"
            base.mkdir(parents=True)
            target = base / ("ab" * 16 + "_h.dat")
            target.write_bytes(b"x")

            md = _downloader(directory)
            files = md._image_files("user", "ab" * 16)
            self.assertEqual(files.get("original"), (str(target), 1))
            self.assertNotIn("mid", files)
            self.assertNotIn("thumb", files)

    def test_missing_h_dat_returns_none(self):
        with tempfile.TemporaryDirectory() as directory:
            md = _downloader(directory)
            self.assertEqual(md._image_files("user", "ab" * 16), {})


class SaveImageBytesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.md = _downloader(self._tmp.name)

    def test_jpeg_magic_gets_jpg_extension(self):
        out = self.md._save_image_bytes(b"\xff\xd8\xffrest", "u", 1, self._tmp.name)
        self.assertTrue(out.endswith("u_1.jpg"))
        self.assertEqual(Path(out).read_bytes(), b"\xff\xd8\xffrest")

    def test_png_magic_gets_png_extension(self):
        out = self.md._save_image_bytes(b"\x89PNGrest", "u", 2, self._tmp.name)
        self.assertTrue(out.endswith("u_2.png"))

    def test_unknown_magic_gets_img_extension(self):
        out = self.md._save_image_bytes(b"\x01\x02\x03", "u", 3, self._tmp.name)
        self.assertTrue(out.endswith("u_3.img"))

    def test_wxgf_without_ffmpeg_is_rejected(self):
        # _ffmpeg_exe 返回 None（找不到 ffmpeg）→ wxgf 不落盘伪图片
        self.md._ffmpeg_exe = lambda: None
        out = self.md._save_image_bytes(b"wxgfXXXX\x00\x00\x00\x01junk", "u", 4, self._tmp.name)
        self.assertIsNone(out)

    def test_wxgf_without_hevc_stream_is_rejected(self):
        self.md._ffmpeg_exe = lambda: "C:\\nonexistent\\ffmpeg.exe"
        out = self.md._save_image_bytes(b"wxgfno-startcode", "u", 5, self._tmp.name)
        self.assertIsNone(out)


class DownloadImageOriginalGuardsTest(unittest.TestCase):
    def test_non_image_message_returns_none_without_ui(self):
        with tempfile.TemporaryDirectory() as directory:
            row = _image_row()
            row["local_type"] = 1  # 文本
            md = _downloader(directory, row)
            self.assertIsNone(md.download_image_original("user", 5))

    def test_missing_row_returns_none_without_ui(self):
        with tempfile.TemporaryDirectory() as directory:
            md = _downloader(directory, row=None)
            self.assertIsNone(md.download_image_original("user", 5))

    def test_missing_md5_returns_none_without_ui(self):
        with tempfile.TemporaryDirectory() as directory:
            row = _image_row()
            row["content"] = b"no hash here"
            row["packed_info"] = None
            md = _downloader(directory, row)
            self.assertIsNone(md.download_image_original("user", 5))

    def test_existing_h_dat_is_decrypted_directly_without_ui(self):
        # 原图已存在时直接解密，不进入 UI 自动化分支（v1.2.4.3 走 _harvest：
        # 要求 ≥ min_bytes(默认 1024，挡空壳)，且解密结果是"完整的图"——
        # ≥16 字节并带 JPEG/PNG 收尾标记）
        with tempfile.TemporaryDirectory() as directory:
            row = _image_row(packed_info=b"ab" * 16)
            md = _downloader(directory, row)
            attach = _attach_dir(directory, "user") / "2026-08"
            attach.mkdir(parents=True)
            h_dat = attach / ("ab" * 16 + "_h.dat")
            # 纯 XOR v0 格式：整文件 ^ key 后是带 FFD9 收尾的完整 JPEG（≥1024B）
            plain = b"\xff\xd8\xff" + b"jpegdata" * 128 + b"\xff\xd9"
            h_dat.write_bytes(bytes(b ^ 0x88 for b in plain))

            out = md.download_image_original("user", 5, save_dir=directory)
            self.assertIsNotNone(out)
            self.assertTrue(out.endswith("user_5.jpg"))
            self.assertEqual(Path(out).read_bytes(), plain)


if __name__ == "__main__":
    unittest.main()
