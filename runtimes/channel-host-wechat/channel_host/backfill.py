"""空库首次启动全量回溯（Backfill）。

当 event store 在本纪元内尚无任何捕获（``channel_events`` 为空且
``source_checkpoints`` 为空）时，把微信客户端里的历史会话/历史消息
合成 ``historical`` channel event 分批写入 ledger，由 Core 幂等摄取入库。

安全边界（任务约束）：
- 绝不创建任何 send operation、绝不调用 GUI、绝不触碰发送链路；
- 事件一律携带 ``historical=True``（eventId 前缀 ``hist:``），Core 摄取时
  只入库展示，不触发 Agent Turn / 记忆捕获 / 通知 / 媒体转写排队；
- 媒体消息只存文本占位（[图片]/[语音]/文件名），不做 ASR/图片描述；
- 开始前先把每个会话的 ``source_checkpoints`` 占坑到当前最大 sort_seq，
  回溯期间增量轮询只捕获占坑之后的新消息，二者并发安全。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
import os
import threading
import time
from typing import Callable, Mapping, Optional
from .event_store import ChannelObservation, EventStore
from .host import _message_chat_discovery_key


# 历史媒体消息的文本占位（协议要求：历史媒体不做转写，仅占位）
HISTORICAL_IMAGE_PLACEHOLDER = "[图片]"
HISTORICAL_VOICE_PLACEHOLDER = "[语音]"


@dataclass(frozen=True)
class BackfillConfig:
    """回溯参数（全部可用环境变量覆盖，见 load_backfill_config）。"""

    include_groups: bool = False
    since_days: int = 30
    batch_size: int = 200
    batch_delay_ms: int = 500
    # 启动时检测空库后自动执行；手动端点不受此开关限制
    auto: bool = True


def load_backfill_config(env: Optional[Mapping[str, str]] = None) -> BackfillConfig:
    env = os.environ if env is None else env

    def _flag(name: str, default: str) -> bool:
        return env.get(name, default).strip().lower() not in ("", "0", "false", "no")

    def _int(name: str, default: int) -> int:
        try:
            return int(str(env.get(name, "")).strip() or default)
        except ValueError:
            return default

    return BackfillConfig(
        include_groups=_flag("WECHAT_BACKFILL_INCLUDE_GROUPS", "0"),
        since_days=max(0, _int("WECHAT_BACKFILL_SINCE_DAYS", 30)),
        batch_size=max(1, _int("WECHAT_BACKFILL_BATCH_SIZE", 200)),
        batch_delay_ms=max(0, _int("WECHAT_BACKFILL_BATCH_DELAY_MS", 500)),
        auto=_flag("WECHAT_BACKFILL_AUTO", "1"),
    )


@dataclass
class BackfillStats:
    """单次回溯统计（写入日志，供验收核对）。"""

    conversations_total: int = 0
    conversations_backfilled: int = 0
    synthesized: int = 0
    inserted: int = 0
    duplicates: int = 0
    skipped_unsupported: int = 0
    elapsed_seconds: float = 0.0
    per_conversation: dict[str, int] = field(default_factory=dict)

    def summary(self) -> str:
        return (
            f"backfill done: conversations={self.conversations_backfilled}"
            f"/{self.conversations_total} synthesized={self.synthesized} "
            f"inserted={self.inserted} duplicates={self.duplicates} "
            f"skipped_unsupported={self.skipped_unsupported} "
            f"elapsed={self.elapsed_seconds:.1f}s"
        )


def _is_group_conversation(conversation_ref: str) -> bool:
    return conversation_ref.endswith("@chatroom")


class BackfillRunner:
    """一次性历史回溯执行器；同一 host 进程内串行（重入安全）。"""

    def __init__(
        self,
        host,
        event_store: EventStore,
        config: BackfillConfig,
        logger: Optional[Callable[[str], None]] = None,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.host = host
        self.event_store = event_store
        self.config = config
        self.logger = logger or (lambda _message: None)
        self._sleep = sleep
        self._lock = threading.Lock()
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    def should_auto_run(self) -> bool:
        """空库信号：store 纪元内尚无任何捕获，且本 store 未做过回溯。"""
        if not self.config.auto:
            return False
        if self.event_store.has_historical_backfill():
            return False
        return self.event_store.is_empty_store()

    def start_async(self, *, auto: bool) -> dict[str, object]:
        """在后台线程执行回溯；返回启动/跳过/冲突状态（供 HTTP 端点）。"""
        with self._lock:
            if self._running:
                return {"started": False, "status": "already_running"}
            if auto and not self.should_auto_run():
                return {"started": False, "status": "store_not_empty"}
            self._running = True
        thread = threading.Thread(
            target=self._run_guarded,
            name="weflow-channel-backfill",
            daemon=True,
        )
        thread.start()
        return {"started": True, "status": "started"}

    def _run_guarded(self) -> None:
        try:
            # _running 已由 start_async 置位；直接执行 _run，
            # 不能走 run()（会因标志位已置而拒绝执行）。
            stats = self._run()
            self.logger(stats.summary())
        except Exception as error:  # 回溯失败不拖垮 host 主循环
            self.logger(f"backfill failed: {error}")
        finally:
            with self._lock:
                self._running = False

    def run(self) -> BackfillStats:
        """同步执行回溯。幂等：重复执行因 hist: eventId 去重不产生第二条。"""
        with self._lock:
            if self._running:
                raise RuntimeError("backfill already running")
            self._running = True
        try:
            return self._run()
        finally:
            with self._lock:
                self._running = False

    def _run(self) -> BackfillStats:
        started = time.monotonic()
        stats = BackfillStats()
        db = self.host.db
        floor_ts = (
            datetime.now(timezone.utc).timestamp() - self.config.since_days * 86400
            if self.config.since_days > 0
            else None
        )

        chats = [
            row
            for row in db.list_message_chats()
            if isinstance(row, dict) and row.get("username")
        ]
        if not self.config.include_groups:
            chats = [
                row for row in chats if not _is_group_conversation(str(row["username"]))
            ]
        stats.conversations_total = len(chats)
        self.logger(
            f"backfill start: conversations={stats.conversations_total} "
            f"include_groups={self.config.include_groups} "
            f"since_days={self.config.since_days} "
            f"batch_size={self.config.batch_size} "
            f"batch_delay_ms={self.config.batch_delay_ms}"
        )

        # 先占坑：把每个会话的水位推进到当前最大 sort_seq，增量轮询从此
        # 只捕获新消息；占坑生效值同时充当各会话历史读取的上界。
        marks: dict[str, int] = {}
        for row in chats:
            conversation_ref = str(row["username"])
            high_water = row.get("max_sort_seq")
            if high_water is None:
                try:
                    high_water = self.host._current_high_water(conversation_ref)
                except ValueError:
                    high_water = 0
            marks[conversation_ref] = max(0, int(high_water))
        claimed = self.event_store.claim_source_checkpoints(marks)

        # 同步 discovery 指纹：占坑后若 discovered_key 落后（backfill 前
        # host.bootstrap 从未对这些会话 record_discovered），下一轮增量
        # 轮询会把「指纹首次落地」误判为有新消息而全量重扫一次。这里
        # 预先写入当前指纹，保证回溯后增量轮询只捕获占坑之后的新消息。
        for row in chats:
            self.event_store.record_discovered(
                str(row["username"]),
                _message_chat_discovery_key(claimed[str(row["username"])][0]),
            )

        pending: list[ChannelObservation] = []
        for row in chats:
            conversation_ref = str(row["username"])
            high_water = claimed[conversation_ref][0]
            captured_for_conversation = 0
            # 跳过已捕获消息（含实时 wechat: 与历史 hist: 事件）：同步端点
            # 只补真正的漏捕消息，不为已入库消息合成冗余 hist: 事件。
            already_captured = self.event_store.message_ids_for_conversation(
                conversation_ref
            )
            for message in self._iter_history(
                db, conversation_ref, high_water, floor_ts
            ):
                local_id = message.get("local_id")
                if local_id is not None and str(local_id) in already_captured:
                    continue
                observation = self._historical_observation(conversation_ref, message)
                if observation is None:
                    stats.skipped_unsupported += 1
                    continue
                stats.synthesized += 1
                pending.append(observation)
                captured_for_conversation += 1
                if len(pending) >= self.config.batch_size:
                    self._flush(pending, stats)
            if captured_for_conversation:
                stats.conversations_backfilled += 1
                stats.per_conversation[conversation_ref] = captured_for_conversation
                self.logger(
                    f"backfill conversation={conversation_ref} "
                    f"messages={captured_for_conversation}"
                )
        self._flush(pending, stats)

        self.event_store.mark_historical_backfill()
        stats.elapsed_seconds = time.monotonic() - started
        return stats

    def _flush(
        self, pending: list[ChannelObservation], stats: BackfillStats
    ) -> None:
        if not pending:
            return
        inserted = self.event_store.append_historical_events(pending)
        stats.inserted += inserted
        stats.duplicates += len(pending) - inserted
        pending.clear()
        if self.config.batch_delay_ms > 0:
            self._sleep(self.config.batch_delay_ms / 1000.0)

    def _iter_history(self, db, conversation_ref: str, high_water: int, floor_ts):
        """按 sort_seq 升序分页读取 sort_seq <= high_water 的历史消息。"""
        since_seq = 0
        while True:
            messages = db.get_new_messages(
                conversation_ref, since_seq=since_seq, limit=200
            )
            if not messages:
                return
            for message in messages:
                sort_seq = message.get("sort_seq")
                if sort_seq is None or int(sort_seq) > high_water:
                    return
                if floor_ts is not None:
                    create_time = message.get("create_time")
                    try:
                        if create_time is not None and float(create_time) < floor_ts:
                            continue
                    except (TypeError, ValueError):
                        continue
                yield message
            since_seq = int(messages[-1]["sort_seq"])
            if len(messages) < 200:
                return

    def _historical_observation(
        self, conversation_ref: str, message: dict
    ) -> Optional[ChannelObservation]:
        """复用实时观察路径合成历史事件，再打上回溯标记与媒体占位。"""
        try:
            observation = self.host._observation(conversation_ref, message)
        except ValueError:
            # 回溯期间不因单条畸形/不支持消息中断（与增量轮询一致）
            return None
        if observation is None:
            return None
        local_id = message.get("local_id")
        event_id = f"hist:{conversation_ref}:{local_id}"
        if observation.kind == "video":
            content = "[视频]"
        elif observation.kind == "image":
            # 历史媒体只存文本占位：不做图片描述
            content: str = HISTORICAL_IMAGE_PLACEHOLDER
        elif observation.kind == "voice":
            # 不做 ASR：有转写文本也统一占位，与任务约束一致
            content = HISTORICAL_VOICE_PLACEHOLDER
        else:
            # 文件消息的 content 已是净化后的文件名；文本/表情/拍一拍原样保留
            content = observation.content
        return replace(
            observation,
            event_id=event_id,
            content=content,
            # mediaRef 原样保留（emotion 无 mediaRef 会被 Core 拒收）
            media_ref=observation.media_ref,
            # 历史消息不做 @ 提及判定，避免触发群聊响应策略
            mentioned=None,
            historical=True,
        )
