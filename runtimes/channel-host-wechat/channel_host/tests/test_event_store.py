import tempfile
import unittest
from pathlib import Path

from channel_host.event_store import ChannelObservation, EventStore


class EventStoreTests(unittest.TestCase):
    def test_durable_capture_deduplicates_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "channel-host.sqlite3"
            store = EventStore(str(path))
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
            store.close()

            reopened = EventStore(str(path))
            page = reopened.pull(after_cursor="0", limit=10)
            self.assertEqual(len(page.events), 1)
            self.assertEqual(page.events[0]["eventId"], "wechat:room-1:11")
            self.assertEqual(page.next_cursor, "1")
            self.assertTrue(reopened.is_bootstrapped())
            reopened.close()


if __name__ == "__main__":
    unittest.main()
