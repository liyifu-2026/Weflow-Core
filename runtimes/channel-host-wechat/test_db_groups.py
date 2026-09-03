"""群成员枚举（contact.db 只读）单元测试：get_groups / get_group_members /
group_name_to_id / group_id_to_name。"""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from wechatauto.db import WeChatDB


def _build_contact_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute(
            "CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, "
            "nick_name TEXT, remark TEXT, alias TEXT)"
        )
        conn.execute(
            "CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, "
            "owner TEXT)"
        )
        conn.execute(
            "CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)"
        )
        conn.executemany(
            "INSERT INTO contact (id, username, nick_name, remark) "
            "VALUES (?, ?, ?, ?)",
            [
                (1, "room@chatroom", "测试群", ""),
                (2, "wxid-a", "Alice", ""),
                (3, "wxid-b", "Bob", "Bob备注"),
                (4, "wxid-c", "Carol", ""),
                (5, "wxid-owner", "Owner", ""),
                (6, "wxid-solo", "Solo", ""),
            ],
        )
        conn.execute(
            "INSERT INTO chat_room (id, username, owner) "
            "VALUES (1, 'room@chatroom', 'wxid-owner')"
        )
        # 第二个群：无成员记录（member_count=0 边界）
        conn.execute(
            "INSERT INTO contact (id, username, nick_name, remark) "
            "VALUES (7, 'empty@chatroom', '空群', '')"
        )
        conn.execute(
            "INSERT INTO chat_room (id, username, owner) "
            "VALUES (2, 'empty@chatroom', 'wxid-owner')"
        )
        conn.executemany(
            "INSERT INTO chatroom_member (room_id, member_id) VALUES (?, ?)",
            [(1, 2), (1, 3), (1, 4), (1, 5)],
        )
        conn.commit()
    finally:
        conn.close()


def _driver(path: Path) -> WeChatDB:
    driver = object.__new__(WeChatDB)
    driver._db_files = [("contact.db", str(path), path.stat().st_size)]

    def _open(_rel):
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        return conn

    driver._open = _open
    return driver


def _driver_without_contact_db() -> WeChatDB:
    driver = object.__new__(WeChatDB)
    driver._db_files = []
    return driver


class GroupApiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        path = Path(self._tmp.name) / "contact.db"
        _build_contact_db(path)
        self.driver = _driver(path)

    def test_get_groups_returns_rooms_with_members_and_owner_flag(self):
        groups = {g["username"]: g for g in self.driver.get_groups()}

        self.assertEqual(set(groups), {"room@chatroom", "empty@chatroom"})
        room = groups["room@chatroom"]
        self.assertEqual(room["name"], "测试群")
        self.assertEqual(room["owner"], "wxid-owner")
        self.assertEqual(room["member_count"], 4)
        members = {m["username"]: m for m in room["members"]}
        self.assertTrue(members["wxid-owner"]["is_owner"])
        self.assertFalse(members["wxid-a"]["is_owner"])
        self.assertEqual(members["wxid-b"]["remark"], "Bob备注")

    def test_get_groups_includes_empty_room(self):
        groups = {g["username"]: g for g in self.driver.get_groups()}
        self.assertEqual(groups["empty@chatroom"]["member_count"], 0)
        self.assertEqual(groups["empty@chatroom"]["members"], [])

    def test_get_group_members_sorted_with_owner_flag(self):
        members = self.driver.get_group_members("room@chatroom")

        self.assertEqual(
            [m["username"] for m in members],
            ["wxid-a", "wxid-b", "wxid-c", "wxid-owner"],
        )
        self.assertEqual(
            [m["is_owner"] for m in members],
            [False, False, False, True],
        )

    def test_get_group_members_missing_room_returns_empty(self):
        self.assertEqual(self.driver.get_group_members("nope@chatroom"), [])

    def test_group_name_to_id_exact_then_substring(self):
        self.assertEqual(self.driver.group_name_to_id("测试群"), "room@chatroom")
        self.assertEqual(self.driver.group_name_to_id("试群"), "room@chatroom")
        self.assertIsNone(self.driver.group_name_to_id("不存在的群"))

    def test_group_id_to_name_round_trip(self):
        self.assertEqual(
            self.driver.group_id_to_name("room@chatroom"), "测试群"
        )
        self.assertIsNone(self.driver.group_id_to_name("nope@chatroom"))

    def test_missing_contact_db_degrades_to_empty(self):
        driver = _driver_without_contact_db()
        self.assertEqual(driver.get_groups(), [])
        self.assertEqual(driver.get_group_members("room@chatroom"), [])
        self.assertIsNone(driver.group_name_to_id("测试群"))
        self.assertIsNone(driver.group_id_to_name("room@chatroom"))


if __name__ == "__main__":
    unittest.main()
