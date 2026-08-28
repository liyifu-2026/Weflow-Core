import sqlite3
import tempfile
import unittest
from pathlib import Path

from channel_host.event_store import ChannelObservation, EventStore


def _observation(event_id: str, content: str = "hello") -> ChannelObservation:
    return ChannelObservation(
        event_id=event_id,
        conversation_ref="room-1",
        channel_message_id=event_id.rsplit(":", 1)[-1],
        sender_ref="wxid-contact",
        kind="text",
        content=content,
        occurred_at="2026-08-17T00:00:00+00:00",
        observed_at="2026-08-17T00:00:01+00:00",
        is_self=False,
    )


class EventStoreTests(unittest.TestCase):
    def test_durable_capture_deduplicates_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "channel-host.sqlite3"
            store = EventStore(str(path))
            try:
                store.bootstrap({"room-1": 10})

                observation = ChannelObservation(
                    event_id="wechat:room-1:11",
                    conversation_ref="room-1",
                    channel_message_id="11",
                    sender_ref="wxid-contact",
                    kind="text",
                    content="hello",
                    occurred_at="2026-08-17T00:00:00+00:00",
                    observed_at="2026-08-17T00:00:01+00:00",
                    is_self=False,
                )
                self.assertTrue(store.capture(observation, source_sort_seq=11))
                self.assertFalse(store.capture(observation, source_sort_seq=11))
                self.assertEqual(store.source_checkpoint("room-1"), 11)
            finally:
                store.close()

            reopened = EventStore(str(path))
            try:
                page = reopened.pull(after_cursor="0", limit=10)
                self.assertEqual(len(page.events), 1)
                self.assertEqual(page.events[0]["eventId"], "wechat:room-1:11")
                self.assertEqual(page.next_cursor, "1")
                self.assertTrue(reopened.is_bootstrapped())
            finally:
                reopened.close()

    def test_cursor_never_rewinds_after_table_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "channel-host.sqlite3"
            store = EventStore(str(path))
            try:
                store.bootstrap({"room-1": 0})
                for i in range(1, 4):
                    store.capture(_observation(f"wechat:room-1:{i}"), 10 + i)
                page = store.pull("0", 10)
                self.assertEqual(page.max_cursor, 3)
            finally:
                store.close()

            # Simulate clearing the ledger (the incident class this guards
            # against): numbering must NOT rewind below the high-water mark,
            # or consumers tracking "pull everything after cursor N" would
            # stall forever. Note: an unqualified `DELETE FROM channel_events`
            # resets sqlite_sequence by design — that catastrophic case is
            # handled by the Core-side regression self-heal instead.
            raw = sqlite3.connect(path)
            try:
                raw.execute("DELETE FROM channel_events WHERE cursor > 0")
                raw.commit()
            finally:
                raw.close()

            # The qualified DELETE keeps sqlite_sequence at the high-water
            # mark (3), so AUTOINCREMENT hands out the next cursor above it
            # (4) — a consumer pulling "after 3" must see the new event.
            new_store = EventStore(str(path))
            try:
                self.assertTrue(
                    new_store.capture(_observation("wechat:room-1:99"), 99)
                )
                page = new_store.pull("3", 10)
                self.assertEqual(len(page.events), 1)
                self.assertEqual(int(page.events[0]["cursor"]), 4)
                self.assertEqual(page.max_cursor, 4)
            finally:
                new_store.close()

    def test_migration_from_plain_integer_primary_key_preserves_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.sqlite3"
            legacy = EventStore(str(path))
            try:
                # Force the pre-AUTOINCREMENT schema.
                legacy._connection.executescript(
                    """
                    DROP TABLE channel_events;
                    CREATE TABLE channel_events (
                        cursor INTEGER PRIMARY KEY,
                        event_id TEXT NOT NULL UNIQUE,
                        conversation_ref TEXT NOT NULL,
                        channel_message_id TEXT,
                        sender_ref TEXT,
                        kind TEXT NOT NULL,
                        content TEXT NOT NULL,
                        occurred_at TEXT,
                        observed_at TEXT NOT NULL,
                        is_self INTEGER NOT NULL
                    );
                    """
                )
            finally:
                legacy.close()
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "INSERT INTO channel_events VALUES (7, 'wechat:room-1:7', "
                    "'room-1', '7', 'wxid-contact', 'text', 'hi', NULL, "
                    "'2026-08-17T00:00:00+00:00', 0)"
                )
                raw.commit()
            finally:
                raw.close()

            migrated = EventStore(str(path))
            try:
                sql = migrated._connection.execute(
                    "SELECT sql FROM sqlite_master WHERE name='channel_events'"
                ).fetchone()[0]
                self.assertIn("AUTOINCREMENT", str(sql))
                page = migrated.pull("0", 10)
                self.assertEqual(len(page.events), 1)
                self.assertEqual(int(page.next_cursor), 7)
                # Allocation continues above the preserved high-water mark.
                self.assertTrue(
                    migrated.capture(_observation("wechat:room-1:8"), 8)
                )
                self.assertEqual(
                    int(migrated.pull("7", 10).events[0]["cursor"]), 8
                )
            finally:
                migrated.close()

    def test_epoch_is_durable_and_changes_with_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "channel-host.sqlite3"
            first = EventStore(str(path))
            try:
                epoch_one = first.epoch()
                self.assertEqual(first.epoch(), epoch_one)
            finally:
                first.close()
            reopened = EventStore(str(path))
            try:
                self.assertEqual(reopened.epoch(), epoch_one)
            finally:
                reopened.close()
            rebuilt = EventStore(str(path))
            try:
                rebuilt._connection.execute(
                    "DELETE FROM host_metadata WHERE key = 'store_epoch'"
                )
                self.assertNotEqual(rebuilt.epoch(), epoch_one)
            finally:
                rebuilt.close()

    def test_pull_reports_max_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "channel-host.sqlite3"
            store = EventStore(str(path))
            try:
                store.bootstrap({})
                empty_page = store.pull("0", 10)
                self.assertEqual(empty_page.max_cursor, 0)
                for i in range(1, 6):
                    store.capture(_observation(f"wechat:room-1:{i}", f"m{i}"), i)
                page = store.pull("2", 2)
                self.assertEqual(page.has_more, True)
                self.assertEqual(page.max_cursor, 5)
                tail = store.pull("4", 2)
                self.assertEqual(tail.has_more, False)
                self.assertEqual(tail.max_cursor, 5)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
