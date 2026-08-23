import sqlite3
import tempfile
import unittest
from pathlib import Path

from wechatauto.db import WeChatDB


class DriverContactTests(unittest.TestCase):
    def _driver(self, directory: str) -> WeChatDB:
        path = Path(directory) / "contact.db"
        connection = sqlite3.connect(path)
        connection.execute(
            "CREATE TABLE contact (username TEXT, nick_name TEXT, remark TEXT, alias TEXT, type INTEGER)"
        )
        connection.executemany(
            "INSERT INTO contact VALUES (?, ?, ?, ?, ?)",
            [
                ("wxid-a", "Alice", "", "alice-alias", 1),
                ("wxid-b", "", "Bob remark", "", 1),
                ("wxid-c", "Carol", "", "", 3),
            ],
        )
        connection.commit()
        connection.close()

        driver = object.__new__(WeChatDB)
        driver._db_files = [("contact.db", str(path), path.stat().st_size)]
        driver._open = lambda _rel: sqlite3.connect(path)
        return driver

    def _driver_with_real_wechat_type_column(self, directory: str) -> WeChatDB:
        path = Path(directory) / "contact.db"
        connection = sqlite3.connect(path)
        connection.execute(
            "CREATE TABLE contact (username TEXT, nick_name TEXT, remark TEXT, alias TEXT, local_type INTEGER)"
        )
        connection.execute(
            "INSERT INTO contact VALUES (?, ?, ?, ?, ?)",
            ("wxid-real", "Real WeChat", "", "", 1),
        )
        connection.commit()
        connection.close()

        driver = object.__new__(WeChatDB)
        driver._db_files = [("contact.db", str(path), path.stat().st_size)]
        driver._open = lambda _rel: sqlite3.connect(path)
        return driver

    def test_contacts_are_sorted_and_cursor_is_opaque_to_the_core(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = self._driver(directory)

            first = driver.list_contacts(limit=2)
            self.assertEqual(
                [item["contactRef"] for item in first["contacts"]],
                ["wxid-a", "wxid-b"],
            )
            self.assertEqual(first["nextCursor"], "wxid-b")
            self.assertTrue(first["hasMore"])
            self.assertEqual(first["contacts"][0]["displayName"], "Alice")
            self.assertEqual(first["contacts"][1]["displayName"], "Bob remark")
            self.assertNotIn("db_storage", first)
            self.assertNotIn("contact.db", first)

            second = driver.list_contacts(after_cursor=first["nextCursor"], limit=2)
            self.assertEqual(
                [item["contactRef"] for item in second["contacts"]], ["wxid-c"]
            )
            self.assertFalse(second["hasMore"])

    def test_invalid_page_size_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = self._driver(directory)
            with self.assertRaises(ValueError):
                driver.list_contacts(limit=0)
            with self.assertRaises(ValueError):
                driver.list_contacts(limit=501)

    def test_real_wechat_local_type_column_is_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = self._driver_with_real_wechat_type_column(directory)

            page = driver.list_contacts(limit=10)

            self.assertEqual(page["contacts"][0]["contactRef"], "wxid-real")
            self.assertEqual(page["contacts"][0]["contactType"], "1")


if __name__ == "__main__":
    unittest.main()
