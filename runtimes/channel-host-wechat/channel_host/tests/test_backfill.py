"""空库历史回溯（Backfill）单元测试。

覆盖验收点：
- eventId 稳定格式 hist:<conversation_ref>:<msgid>，重复回溯幂等（不产生第二条）；
- 先占坑 source_checkpoints 后，增量轮询不重复捕获历史消息；
- 分批与限速参数生效（batch_size / batch_delay_ms）；
- 媒体占位（[图片]/[语音]）与不做 @ 判定；
- 空库判定信号（channel_events + source_checkpoints 双空）；
- 手动触发端点的鉴权与状态码。
"""

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from channel_host.backfill import (
    BackfillConfig,
    BackfillRunner,
    load_backfill_config,
)
from channel_host.event_store import ChannelObservation, EventStore
from channel_host.host import WeChatChannelHost
from channel_host.http_host import ChannelHostHttpServer


def _ts(offset_hours: float) -> float:
    base = datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp()
    return base + offset_hours * 3600


class FakeWeChatDb:
    """与 test_host_polling 相同模式的微信 DB 桩。"""

    def __init__(self):
        self.messages = {"room-1": [], "room-2": [], "room-3@chatroom": []}

    def list_message_chats(self):
        # 真实 DB 只对存在消息表的会话返回行；空列表视为无消息表
        return [
            {
                "username": username,
                "max_sort_seq": max(
                    (m["sort_seq"] for m in messages), default=0
                ),
            }
            for username, messages in self.messages.items()
            if messages
        ]

    def get_sessions(self, limit=10000):
        return []

    def get_messages(self, user, limit=20, offset=0):
        return list(reversed(self.messages[user]))[offset : offset + limit]

    def get_new_messages(self, user, since_seq=0, limit=200):
        return [
            m for m in self.messages[user] if m["sort_seq"] > since_seq
        ][:limit]

    def get_self_info(self):
        return {"username": "wxid_self", "nick_name": "自机"}


def _text_msg(index: int, sort_seq: int, content: str, create_time: float):
    return {
        "local_id": index,
        "type": "文本",
        "sender_id": "wxid_contact",
        "create_time": create_time,
        "content": content,
        "sort_seq": sort_seq,
    }


class BackfillIdempotencyTests(unittest.TestCase):
    def test_hist_event_id_is_stable_and_rerun_inserts_nothing_new(self):
        """重复回溯第二遍：消息数不变（eventId 幂等兜底）。"""
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [
                _text_msg(1, 1, "旧消息一", _ts(1)),
                _text_msg(2, 2, "旧消息二", _ts(2)),
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            logs = []
            runner.logger = logs.append

            first = runner.run()
            self.assertEqual(first.synthesized, 2)
            self.assertEqual(first.inserted, 2)
            page = store.pull()
            self.assertEqual(len(page.events), 2)
            self.assertEqual(
                [e["eventId"] for e in page.events],
                ["hist:room-1:1", "hist:room-1:2"],
            )

            second = runner.run()
            # 语义增强：已捕获消息在合成前即被跳过（而非入库时去重）
            self.assertEqual(second.synthesized, 0)
            self.assertEqual(second.inserted, 0)
            self.assertEqual(len(store.pull().events), 2)
            store.close()

    def test_historical_events_are_marked_and_media_get_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [
                _text_msg(1, 1, "文本历史", _ts(1)),
                {
                    "local_id": 2,
                    "type": "图片",
                    "local_type": 3,
                    "sender_id": "wxid_contact",
                    "create_time": _ts(2),
                    "content": b"[image]",
                    "sort_seq": 2,
                },
                {
                    "local_id": 3,
                    "type": "语音",
                    "local_type": 34,
                    "sender_id": "wxid_contact",
                    "create_time": _ts(3),
                    "content": "语音转写文本",
                    "sort_seq": 3,
                },
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            stats = runner.run()
            self.assertEqual(stats.inserted, 3)
            events = {e["eventId"]: e for e in store.pull().events}
            text = events["hist:room-1:1"]
            self.assertTrue(text["historical"])
            self.assertEqual(text["content"], "文本历史")
            self.assertNotIn("mentioned", text)
            image = events["hist:room-1:2"]
            self.assertEqual(image["content"], "[图片]")
            self.assertTrue(str(image["mediaRef"]).startswith("wechat-media:v1:"))
            voice = events["hist:room-1:3"]
            # 不做 ASR：有转写文本也统一占位
            self.assertEqual(voice["content"], "[语音]")
            self.assertTrue(str(voice["mediaRef"]).startswith("wechat-media:v1:"))
            store.close()

    def test_checkpoints_claimed_first_so_incremental_poll_skips_history(self):
        """先占坑：回溯后增量轮询不重复捕获，只捕获占坑之后的新消息。"""
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [
                _text_msg(1, 10, "历史一", _ts(1)),
                _text_msg(2, 20, "历史二", _ts(2)),
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(
                db,
                store,
                # 立即重发现（默认 30s 窗口内 message chats 不重扫）
                message_chat_discovery_interval_seconds=0.0,
            )
            config = BackfillConfig(since_days=0, batch_delay_ms=0)
            runner = BackfillRunner(host, store, config)
            stats = runner.run()
            self.assertEqual(stats.inserted, 2)
            self.assertEqual(store.source_checkpoint("room-1"), 20)

            # 增量轮询：历史不再捕获
            self.assertEqual(host.poll_once(), 0)
            self.assertEqual(len(store.pull().events), 2)

            # 占坑之后的新消息照常实时捕获
            db.messages["room-1"].append(
                _text_msg(3, 30, "新消息", _ts(3))
            )
            self.assertEqual(host.poll_once(), 1)
            events = store.pull().events
            self.assertEqual(len(events), 3)
            self.assertEqual(events[-1]["eventId"], "wechat:room-1:3")
            self.assertNotIn("historical", events[-1])
            store.close()

    def test_group_excluded_by_default_and_included_by_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [_text_msg(1, 1, "私聊", _ts(1))]
            db.messages["room-3@chatroom"] = [_text_msg(1, 1, "群聊", _ts(1))]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            default_runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            stats = default_runner.run()
            self.assertEqual(stats.conversations_total, 1)
            self.assertEqual(
                [e["eventId"] for e in store.pull().events], ["hist:room-1:1"]
            )
            store.close()

            store2 = EventStore(str(Path(directory) / "events2.sqlite3"))
            try:
                host2 = WeChatChannelHost(db, store2)
                group_runner = BackfillRunner(
                    host2,
                    store2,
                    BackfillConfig(
                        include_groups=True, since_days=0, batch_delay_ms=0
                    ),
                )
                stats2 = group_runner.run()
                self.assertEqual(stats2.conversations_total, 2)
                self.assertEqual(len(store2.pull().events), 2)
            finally:
                store2.close()

    def test_batch_size_and_delay_are_respected(self):
        """分批 200 条/批、批间 sleep（可配）生效。"""
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [
                _text_msg(i, i, f"消息{i}", _ts(i)) for i in range(1, 451)
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            sleeps: list[float] = []
            runner = BackfillRunner(
                host,
                store,
                BackfillConfig(
                    since_days=0, batch_size=200, batch_delay_ms=500
                ),
                sleep=sleeps.append,
            )
            stats = runner.run()
            self.assertEqual(stats.synthesized, 450)
            self.assertEqual(stats.inserted, 450)
            # 450 条按 200 分批 → 3 批 → 3 次 flush sleep（每批写完各一次）
            self.assertEqual(len(sleeps), 3)
            for delay in sleeps:
                self.assertEqual(delay, 0.5)
            store.close()

    def test_since_days_filters_old_messages_zero_means_unlimited(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [
                _text_msg(1, 1, "很久以前", _ts(-24 * 60)),  # 60 天前
                _text_msg(2, 2, "最近", _ts(-1)),  # 1 小时前
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=30, batch_delay_ms=0)
            )
            stats = runner.run()
            self.assertEqual(stats.inserted, 1)
            self.assertEqual(
                [e["eventId"] for e in store.pull().events], ["hist:room-1:2"]
            )
            store.close()

            store2 = EventStore(str(Path(directory) / "events2.sqlite3"))
            try:
                host2 = WeChatChannelHost(db, store2)
                runner2 = BackfillRunner(
                    host2, store2, BackfillConfig(since_days=0, batch_delay_ms=0)
                )
                stats2 = runner2.run()
                self.assertEqual(stats2.inserted, 2)
            finally:
                store2.close()

    def test_empty_store_signal(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [_text_msg(1, 1, "历史", _ts(1))]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            # 空库：channel_events 与 source_checkpoints 双空
            self.assertTrue(store.is_empty_store())
            self.assertTrue(runner.should_auto_run())

            # bootstrap 后水位占坑 → 非空，不再自动回溯
            host.bootstrap()
            self.assertFalse(store.is_empty_store())
            self.assertFalse(runner.should_auto_run())
            store.close()

    def test_backfill_marker_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [_text_msg(1, 1, "历史", _ts(1))]
            path = str(Path(directory) / "events.sqlite3")
            store = EventStore(path)
            host = WeChatChannelHost(db, store)
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            runner.run()
            self.assertTrue(store.has_historical_backfill())
            store.close()

            reopened = EventStore(path)
            self.assertTrue(reopened.has_historical_backfill())
            reopened.close()


class BackfillConfigTests(unittest.TestCase):
    def test_env_overrides(self):
        config = load_backfill_config(
            {
                "WECHAT_BACKFILL_INCLUDE_GROUPS": "1",
                "WECHAT_BACKFILL_SINCE_DAYS": "0",
                "WECHAT_BACKFILL_BATCH_SIZE": "50",
                "WECHAT_BACKFILL_BATCH_DELAY_MS": "0",
            }
        )
        self.assertTrue(config.include_groups)
        self.assertEqual(config.since_days, 0)
        self.assertEqual(config.batch_size, 50)
        self.assertEqual(config.batch_delay_ms, 0)

    def test_defaults(self):
        config = load_backfill_config({})
        self.assertFalse(config.include_groups)
        self.assertEqual(config.since_days, 30)
        self.assertEqual(config.batch_size, 200)
        self.assertEqual(config.batch_delay_ms, 500)
        self.assertTrue(config.auto)


class BackfillEndpointTests(unittest.TestCase):
    def _post(self, server, path, body=None):
        payload = json.dumps(body).encode("utf-8") if body else None
        request = Request(
            f"{server.base_url}{path}",
            method="POST",
            headers={"Authorization": "Bearer host-secret"},
            data=payload,
        )
        try:
            response = urlopen(request, timeout=5)
            return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_manual_endpoint_requires_auth_and_reports_state(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [_text_msg(1, 1, "历史", _ts(1))]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                backfill_runner=runner,
            )
            server.start()
            try:
                # 未鉴权 → 401
                try:
                    urlopen(
                        Request(
                            f"{server.base_url}/api/v1/channel/backfill",
                            method="POST",
                        ),
                        timeout=5,
                    )
                    self.fail("expected 401")
                except HTTPError as error:
                    self.assertEqual(error.code, 401)

                # 空库 → 接受并启动
                status, payload = self._post(
                    server, "/api/v1/channel/backfill"
                )
                self.assertEqual(status, 202)
                self.assertTrue(payload["started"])

                # 等待后台完成（start_async 只是提交线程，需要轮询收敛）
                import time

                for _ in range(200):
                    if not runner.running:
                        break
                    time.sleep(0.05)
                self.assertFalse(runner.running)
                deadline_events = len(store.pull().events)
                self.assertEqual(deadline_events, 1)

                # 已回溯过 → 409 store_not_empty
                status, payload = self._post(
                    server, "/api/v1/channel/backfill"
                )
                self.assertEqual(status, 409)
                self.assertEqual(payload["error"], "store_not_empty")

                # force=true 可对非空 store 重跑（幂等，不产生第二条）
                status, payload = self._post(
                    server,
                    "/api/v1/channel/backfill",
                    body={"force": True},
                )
                self.assertEqual(status, 202)
                self.assertTrue(payload["started"])
                for _ in range(200):
                    if not runner.running:
                        break
                    time.sleep(0.05)
                self.assertFalse(runner.running)
                self.assertEqual(len(store.pull().events), 1)
            finally:
                server.close()
                store.close()

    def test_sync_endpoint_reuses_backfill_and_marks_historical(self):
        """「立即同步」复用 historical 回溯：补漏零副作用，幂等。"""
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"] = [
                _text_msg(1, 1, "已捕获的实时消息", _ts(1)),
                _text_msg(2, 2, "漏捕的历史消息", _ts(2)),
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            # 预置：实时链路已捕获第 1 条（wechat: 前缀），第 2 条漏捕
            host.bootstrap()
            store.capture(
                ChannelObservation(
                    event_id="wechat:room-1:1",
                    conversation_ref="room-1",
                    channel_message_id="1",
                    sender_ref="wxid_contact",
                    kind="text",
                    content="已捕获的实时消息",
                    occurred_at=None,
                    observed_at="2026-01-01T00:00:00+00:00",
                    is_self=False,
                ),
                1,
            )
            runner = BackfillRunner(
                host, store, BackfillConfig(since_days=0, batch_delay_ms=0)
            )
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                backfill_runner=runner,
            )
            server.start()
            try:
                # POST /sync → 202 started（不再返回 resetConversations）
                status, payload = self._post(server, "/api/v1/channel/sync")
                self.assertEqual(status, 202)
                self.assertTrue(payload["started"])

                for _ in range(200):
                    if not runner.running:
                        break
                    import time

                    time.sleep(0.05)
                self.assertFalse(runner.running)

                events = store.pull().events
                by_id = {e["eventId"]: e for e in events}
                # 实时事件保持不变
                self.assertIn("wechat:room-1:1", by_id)
                self.assertNotIn("historical", by_id["wechat:room-1:1"])
                # 漏捕消息以 historical 事件补入（hist: 前缀）
                self.assertIn("hist:room-1:2", by_id)
                self.assertTrue(by_id["hist:room-1:2"]["historical"])
                self.assertEqual(len(events), 2)

                # 再触发一次同步：幂等，不产生第三条
                status, payload = self._post(server, "/api/v1/channel/sync")
                self.assertEqual(status, 202)
                for _ in range(200):
                    if not runner.running:
                        break
                    import time

                    time.sleep(0.05)
                self.assertEqual(len(store.pull().events), 2)
            finally:
                server.close()
                store.close()


if __name__ == "__main__":
    unittest.main()
