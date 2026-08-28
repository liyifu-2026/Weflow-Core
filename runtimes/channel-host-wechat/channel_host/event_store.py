"""Durable inbound observation ledger for the local WeChat Channel Host."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import sqlite3
import threading
import uuid
from typing import Iterable, Mapping, Optional


@dataclass(frozen=True)
class ChannelObservation:
    event_id: str
    conversation_ref: str
    channel_message_id: Optional[str]
    sender_ref: Optional[str]
    kind: str
    content: str
    occurred_at: Optional[str]
    observed_at: str
    is_self: bool
    media_ref: Optional[str] = None
    file_name: Optional[str] = None
    mime_type: Optional[str] = None
    source_metadata: Optional[Mapping[str, object]] = None
    account: Optional[str] = None
    mentioned: Optional[bool] = None
    reply_to_channel_message_id: Optional[str] = None
    # 空库 Backfill 合成的历史回溯事件；Core 摄取时只入库，不触发任何 AI 副作用。
    historical: bool = False


@dataclass(frozen=True)
class EventPage:
    events: list[dict[str, object]]
    next_cursor: str
    has_more: bool
    # Highest cursor currently allocated in the ledger; lets consumers detect
    # a wiped/rebuilt store whose numbering restarted below their watermark.
    max_cursor: int = 0


@dataclass(frozen=True)
class SendOperationClaim:
    operation: dict[str, object]
    baseline_sort_seq: int


class SendOperationConflict(ValueError):
    """The same operation ID was reused for a different send payload."""


class EventStore:
    """SQLite-backed event ledger with a durable source checkpoint.

    The observation row and the per-conversation ``sort_seq`` checkpoint are
    committed in one transaction. A duplicate event ID is harmless and does
    not allocate a second host cursor.
    """

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            path, check_same_thread=False, isolation_level=None
        )
        self._connection.row_factory = sqlite3.Row
        try:
            with self._lock:
                self._connection.execute("PRAGMA journal_mode=WAL")
                self._connection.execute("PRAGMA synchronous=FULL")
                self._connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS channel_events (
                        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_id TEXT NOT NULL UNIQUE,
                        conversation_ref TEXT NOT NULL,
                        channel_message_id TEXT,
                        sender_ref TEXT,
                        kind TEXT NOT NULL,
                        content TEXT NOT NULL,
                        occurred_at TEXT,
                        observed_at TEXT NOT NULL,
                        is_self INTEGER NOT NULL,
                        media_ref TEXT,
                        file_name TEXT,
                        mime_type TEXT,
                        account TEXT,
                        source_metadata TEXT
                    );

                    CREATE TABLE IF NOT EXISTS source_checkpoints (
                        conversation_ref TEXT PRIMARY KEY,
                        sort_seq INTEGER NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS discovered_conversations (
                        conversation_ref TEXT PRIMARY KEY,
                        discovery_key TEXT NOT NULL,
                        discovered_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS host_metadata (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS channel_send_operations (
                        operation_id TEXT PRIMARY KEY,
                        conversation_ref TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        state TEXT NOT NULL,
                        error TEXT,
                        channel_message_id TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    """
                )
                self._ensure_channel_event_columns()
                self._ensure_send_operation_columns()
                self._migrate_channel_events_cursor_monotonic()
        except Exception:
            # Any failure above leaves the connection open and the db file
            # locked on Windows; close it so callers / tests can clean up.
            self._connection.close()
            raise

    def _migrate_channel_events_cursor_monotonic(self) -> None:
        """Rebuild `channel_events` with an AUTOINCREMENT cursor.

        The previous `MAX(cursor)+1` allocator renumbered from 1 whenever the
        table was cleared (manual wipe, store rebuild), silently rewinding the
        pull progress published to Core and stalling ingestion forever. With
        AUTOINCREMENT, sqlite_sequence keeps the high-water mark across
        clears, so cursors never regress. Existing rows keep their cursors.
        Tolerates any historical column set by copying only the columns that
        actually exist in the old table.
        """
        row = self._connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_events'"
        ).fetchone()
        if row is None or "AUTOINCREMENT" in str(row[0]):
            return
        old_columns = [
            str(item[1])
            for item in self._connection.execute(
                "PRAGMA table_info(channel_events)"
            ).fetchall()
        ]
        column_list = ", ".join(old_columns)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                self._connection.execute(
                    """
                    CREATE TABLE channel_events_monotonic (
                        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_id TEXT NOT NULL UNIQUE,
                        conversation_ref TEXT NOT NULL,
                        channel_message_id TEXT,
                        sender_ref TEXT,
                        kind TEXT NOT NULL,
                        content TEXT NOT NULL,
                        occurred_at TEXT,
                        observed_at TEXT NOT NULL,
                        is_self INTEGER NOT NULL,
                        media_ref TEXT,
                        file_name TEXT,
                        mime_type TEXT,
                        account TEXT,
                        source_metadata TEXT,
                        mentioned INTEGER,
                        reply_to_channel_message_id TEXT,
                        historical INTEGER NOT NULL DEFAULT 0
                    )
                    """
                )
                self._connection.execute(
                    f"INSERT INTO channel_events_monotonic ({column_list}) "
                    f"SELECT {column_list} FROM channel_events ORDER BY cursor"
                )
                self._connection.execute("DROP TABLE channel_events")
                self._connection.execute(
                    "ALTER TABLE channel_events_monotonic "
                    "RENAME TO channel_events"
                )
                self._connection.execute("COMMIT")
            except Exception:
                try:
                    self._connection.execute("ROLLBACK")
                except sqlite3.OperationalError:
                    pass  # nothing to roll back (e.g. script already aborted)
                raise

    def _ensure_channel_event_columns(self) -> None:
        columns = {
            str(row[1])
            for row in self._connection.execute(
                "PRAGMA table_info(channel_events)"
            ).fetchall()
        }
        if "media_ref" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN media_ref TEXT"
            )
        if "file_name" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN file_name TEXT"
            )
        if "mime_type" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN mime_type TEXT"
            )
        # ADR-0005：多微信账号隔离，事件携带来源实例的 account（空值由 Core 回落 default）
        if "account" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN account TEXT"
            )
        if "mentioned" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN mentioned INTEGER"
            )
        if "reply_to_channel_message_id" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN reply_to_channel_message_id TEXT"
            )
        # 空库 Backfill：历史回溯事件标记（协议 v2 的 historical 字段）
        if "historical" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_events ADD COLUMN historical INTEGER NOT NULL DEFAULT 0"
            )

    def _ensure_send_operation_columns(self) -> None:
        columns = {
            str(row[1])
            for row in self._connection.execute(
                "PRAGMA table_info(channel_send_operations)"
            ).fetchall()
        }
        if "baseline_sort_seq" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_send_operations "
                "ADD COLUMN baseline_sort_seq INTEGER"
            )
        if "attempts" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_send_operations "
                "ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"
            )
        if "lease_until" not in columns:
            self._connection.execute(
                "ALTER TABLE channel_send_operations ADD COLUMN lease_until TEXT"
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def is_bootstrapped(self) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM host_metadata WHERE key = 'bootstrapped'"
            ).fetchone()
        return row is not None and row[0] == "1"

    def bootstrap(
        self,
        high_water_marks: Mapping[str, int],
        discovered_keys: Optional[Mapping[str, str]] = None,
    ) -> bool:
        """Persist the first-start baseline without publishing old messages."""
        discovered_keys = discovered_keys or {}
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                existing = self._connection.execute(
                    "SELECT value FROM host_metadata WHERE key = 'bootstrapped'"
                ).fetchone()
                if existing is not None:
                    self._connection.execute("COMMIT")
                    return False
                for conversation_ref, sort_seq in high_water_marks.items():
                    self._connection.execute(
                        "INSERT OR IGNORE INTO source_checkpoints "
                        "(conversation_ref, sort_seq) VALUES (?, ?)",
                        (conversation_ref, int(sort_seq)),
                    )
                now = datetime.now(timezone.utc).isoformat()
                for conversation_ref, discovery_key in discovered_keys.items():
                    self._connection.execute(
                        """
                        INSERT OR IGNORE INTO discovered_conversations (
                            conversation_ref, discovery_key, discovered_at, updated_at
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (conversation_ref, discovery_key, now, now),
                    )
                self._connection.execute(
                    "INSERT INTO host_metadata (key, value) VALUES ('bootstrapped', '1')"
                )
                self._connection.execute("COMMIT")
                return True
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def ensure_conversation(
        self,
        conversation_ref: str,
        high_water: int,
        discovery_key: Optional[str] = None,
    ) -> bool:
        """Baseline a conversation discovered after the initial bootstrap."""
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                cursor = self._connection.execute(
                    "INSERT OR IGNORE INTO source_checkpoints "
                    "(conversation_ref, sort_seq) VALUES (?, ?)",
                    (conversation_ref, int(high_water)),
                )
                if discovery_key is not None:
                    now = datetime.now(timezone.utc).isoformat()
                    self._connection.execute(
                        """
                        INSERT OR IGNORE INTO discovered_conversations (
                            conversation_ref, discovery_key, discovered_at, updated_at
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (conversation_ref, discovery_key, now, now),
                    )
                self._connection.execute("COMMIT")
                return cursor.rowcount == 1
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def discovered_key(self, conversation_ref: str) -> Optional[str]:
        with self._lock:
            row = self._connection.execute(
                "SELECT discovery_key FROM discovered_conversations "
                "WHERE conversation_ref = ?",
                (conversation_ref,),
            ).fetchone()
        return str(row[0]) if row is not None else None

    def message_ids_for_conversation(self, conversation_ref: str) -> set[str]:
        """该会话已捕获过的全部 channel_message_id（实时 + 历史回溯）。

        Backfill 用它跳过已捕获消息：同步端点只补真正的漏捕消息，
        不为已入库消息合成冗余的 hist: 事件。
        """
        with self._lock:
            rows = self._connection.execute(
                "SELECT channel_message_id FROM channel_events "
                "WHERE conversation_ref = ?",
                (conversation_ref,),
            ).fetchall()
        return {str(row[0]) for row in rows if row[0] is not None}

    def record_discovered(self, conversation_ref: str, discovery_key: str) -> None:
        """Commit the latest cheap discovery fingerprint for a conversation."""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO discovered_conversations (
                    conversation_ref, discovery_key, discovered_at, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(conversation_ref) DO UPDATE SET
                    discovery_key = excluded.discovery_key,
                    updated_at = excluded.updated_at
                """,
                (conversation_ref, discovery_key, now, now),
            )

    def source_checkpoint(self, conversation_ref: str) -> Optional[int]:
        with self._lock:
            row = self._connection.execute(
                "SELECT sort_seq FROM source_checkpoints WHERE conversation_ref = ?",
                (conversation_ref,),
            ).fetchone()
        return int(row[0]) if row is not None else None

    def reset_source_checkpoints(self) -> int:
        """Reset every conversation source watermark to 0.

        The next poll re-scans WeChat DB history for each conversation.
        channel_events dedupes by event_id, so already-captured messages are
        skipped; only new / previously skipped rows (new media, new types,
        messages that arrived while the checkpoint was ahead) get captured.
        """
        with self._lock:
            cursor = self._connection.execute(
                "UPDATE source_checkpoints SET sort_seq = 0 WHERE sort_seq > 0"
            )
            return int(cursor.rowcount)

    def find_media_source(self, media_ref: str) -> Optional[dict[str, object]]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT conversation_ref, channel_message_id, kind, file_name
                FROM channel_events
                WHERE media_ref = ?
                ORDER BY cursor ASC
                LIMIT 1
                """,
                (media_ref,),
            ).fetchone()
        if row is None:
            return None
        return {
            "conversationRef": row["conversation_ref"],
            "channelMessageId": row["channel_message_id"],
            "kind": row["kind"],
            "fileName": row["file_name"],
        }

    def capture(self, observation: ChannelObservation, source_sort_seq: int) -> bool:
        """Atomically insert an observation and advance its source checkpoint."""
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                result = self._connection.execute(
                    """
                    INSERT OR IGNORE INTO channel_events (
                        event_id, conversation_ref, channel_message_id,
                        sender_ref, kind, content, occurred_at, observed_at,
                        is_self, media_ref, file_name, mime_type, account,
                        source_metadata, mentioned, reply_to_channel_message_id,
                        historical
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        observation.event_id,
                        observation.conversation_ref,
                        observation.channel_message_id,
                        observation.sender_ref,
                        observation.kind,
                        observation.content,
                        observation.occurred_at,
                        observation.observed_at,
                        1 if observation.is_self else 0,
                        observation.media_ref,
                        observation.file_name,
                        observation.mime_type,
                        observation.account,
                        json.dumps(observation.source_metadata)
                        if observation.source_metadata is not None
                        else None,
                        1 if observation.mentioned else 0
                        if observation.mentioned is not None else None,
                        observation.reply_to_channel_message_id,
                        1 if observation.historical else 0,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO source_checkpoints (conversation_ref, sort_seq)
                    VALUES (?, ?)
                    ON CONFLICT(conversation_ref) DO UPDATE SET sort_seq =
                      CASE WHEN excluded.sort_seq > source_checkpoints.sort_seq
                           THEN excluded.sort_seq
                           ELSE source_checkpoints.sort_seq END
                    """,
                    (observation.conversation_ref, int(source_sort_seq)),
                )
                self._connection.execute("COMMIT")
                return result.rowcount == 1
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def advance_checkpoint(self, conversation_ref: str, sort_seq: int) -> None:
        """Commit an intentional unsupported-message observation boundary."""
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO source_checkpoints (conversation_ref, sort_seq)
                VALUES (?, ?)
                ON CONFLICT(conversation_ref) DO UPDATE SET sort_seq =
                  CASE WHEN excluded.sort_seq > source_checkpoints.sort_seq
                       THEN excluded.sort_seq
                       ELSE source_checkpoints.sort_seq END
                """,
                (conversation_ref, int(sort_seq)),
            )

    def claim_source_checkpoints(
        self, marks: Mapping[str, int]
    ) -> dict[str, tuple[int, bool]]:
        """「先占坑」：把每个会话的水位直接推进到当前最大 sort_seq。

        空库 Backfill 开始前调用：占坑后增量轮询不会再把同一批历史消息
        当作新消息重复捕获（增量只捕获 checkpoint 之后的行），回溯与
        增量并发安全。返回 {conversation_ref: (生效水位, 是否新占坑)}。
        """
        result: dict[str, tuple[int, bool]] = {}
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                for conversation_ref, sort_seq in marks.items():
                    row = self._connection.execute(
                        "SELECT sort_seq FROM source_checkpoints "
                        "WHERE conversation_ref = ?",
                        (conversation_ref,),
                    ).fetchone()
                    existed = row is not None
                    effective = int(sort_seq)
                    if existed and int(row["sort_seq"]) > effective:
                        effective = int(row["sort_seq"])
                    self._connection.execute(
                        """
                        INSERT INTO source_checkpoints (conversation_ref, sort_seq)
                        VALUES (?, ?)
                        ON CONFLICT(conversation_ref) DO UPDATE SET sort_seq =
                          CASE WHEN excluded.sort_seq > source_checkpoints.sort_seq
                               THEN excluded.sort_seq
                               ELSE source_checkpoints.sort_seq END
                        """,
                        (conversation_ref, int(sort_seq)),
                    )
                    result[conversation_ref] = (effective, not existed)
                self._connection.execute("COMMIT")
            except Exception:
                self._connection.execute("ROLLBACK")
                raise
        return result

    def is_empty_store(self) -> bool:
        """空库判定：store 纪元内尚无任何捕获（无事件且无水位）。

        用于「Core 空库首次启动全量回溯」的一次性触发信号；事件被
        摄取过（哪怕随后被清理）或水位已建立，均视为非空，不再自动回溯。
        """
        with self._lock:
            events = self._connection.execute(
                "SELECT 1 FROM channel_events LIMIT 1"
            ).fetchone()
            if events is not None:
                return False
            checkpoints = self._connection.execute(
                "SELECT 1 FROM source_checkpoints LIMIT 1"
            ).fetchone()
        return checkpoints is None

    def has_historical_backfill(self) -> bool:
        """本 store 是否已发生过历史回溯（host_metadata 持久标记）。"""
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM host_metadata WHERE key = 'historical_backfill'"
            ).fetchone()
        return row is not None and row[0] == "1"

    def mark_historical_backfill(self) -> None:
        with self._lock:
            self._connection.execute(
                "INSERT INTO host_metadata (key, value) "
                "VALUES ('historical_backfill', '1') "
                "ON CONFLICT(key) DO UPDATE SET value = '1'"
            )

    def append_historical_events(
        self, observations: list[ChannelObservation]
    ) -> int:
        """批量写入历史回溯事件（单事务，event_id 幂等），返回新增条数。

        仅写入 channel_events，不动 source_checkpoints——水位由
        claim_source_checkpoints 先行占坑，回溯期间发现的增量消息
        （sort_seq 更大的新行）由增量轮询照常捕获。
        """
        if not observations:
            return 0
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                inserted = 0
                for observation in observations:
                    result = self._connection.execute(
                        """
                        INSERT OR IGNORE INTO channel_events (
                            event_id, conversation_ref, channel_message_id,
                            sender_ref, kind, content, occurred_at, observed_at,
                            is_self, media_ref, file_name, mime_type, account,
                            source_metadata, mentioned, reply_to_channel_message_id,
                            historical
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                        """,
                        (
                            observation.event_id,
                            observation.conversation_ref,
                            observation.channel_message_id,
                            observation.sender_ref,
                            observation.kind,
                            observation.content,
                            observation.occurred_at,
                            observation.observed_at,
                            1 if observation.is_self else 0,
                            observation.media_ref,
                            observation.file_name,
                            observation.mime_type,
                            observation.account,
                            json.dumps(observation.source_metadata)
                            if observation.source_metadata is not None
                            else None,
                            1 if observation.mentioned else 0
                            if observation.mentioned is not None else None,
                            observation.reply_to_channel_message_id,
                        ),
                    )
                    inserted += result.rowcount
                self._connection.execute("COMMIT")
                return inserted
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def pull(self, after_cursor: str = "0", limit: int = 100) -> EventPage:
        after = _parse_cursor(after_cursor)
        if not isinstance(limit, int) or limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT cursor, event_id, conversation_ref, channel_message_id,
                       sender_ref, kind, content, occurred_at, observed_at,
                       is_self, media_ref, file_name, mime_type, account,
                       mentioned, reply_to_channel_message_id, historical
                FROM channel_events
                WHERE cursor > ?
                ORDER BY cursor ASC
                LIMIT ?
                """,
                (after, limit + 1),
            ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        events = [_event_dict(row) for row in page_rows]
        next_cursor = str(page_rows[-1]["cursor"]) if page_rows else after_cursor
        max_cursor = self._connection.execute(
            "SELECT COALESCE(MAX(cursor), 0) FROM channel_events"
        ).fetchone()[0]
        return EventPage(
            events=events,
            next_cursor=next_cursor,
            has_more=has_more,
            max_cursor=int(max_cursor),
        )

    def epoch(self) -> str:
        """Durable identity of this store generation.

        Survives process restarts; changes (a new UUID is minted) only when
        the underlying ledger is rebuilt from scratch. Consumers can compare
        epochs to detect a store swap even when cursors happen to align.
        """
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM host_metadata WHERE key = 'store_epoch'"
            ).fetchone()
            if row is not None:
                return str(row[0])
            epoch = uuid.uuid4().hex
            self._connection.execute(
                "INSERT OR IGNORE INTO host_metadata (key, value) "
                "VALUES ('store_epoch', ?)",
                (epoch,),
            )
            return epoch

    def readable(self) -> bool:
        with self._lock:
            self._connection.execute("SELECT 1").fetchone()
        return True

    def create_send_operation(
        self, operation_id: str, conversation_ref: str, payload: Mapping[str, object]
    ) -> dict[str, object]:
        payload_json = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        with self._lock:
            existing = self._connection.execute(
                """
                SELECT operation_id, conversation_ref, payload_json, state, error,
                       channel_message_id, created_at, updated_at
                FROM channel_send_operations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
            if existing is not None:
                if (
                    existing["conversation_ref"] != conversation_ref
                    or existing["payload_json"] != payload_json
                ):
                    raise SendOperationConflict(
                        "send_operation_identity_conflict"
                    )
                return _send_operation_dict(existing)

            now = datetime.now(timezone.utc).isoformat()
            self._connection.execute(
                """
                INSERT INTO channel_send_operations (
                    operation_id, conversation_ref, payload_json, state, error,
                    channel_message_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    operation_id,
                    conversation_ref,
                    payload_json,
                    "pending",
                    None,
                    None,
                    now,
                    now,
                ),
            )
            row = self._connection.execute(
                """
                SELECT operation_id, conversation_ref, payload_json, state, error,
                       channel_message_id, created_at, updated_at
                FROM channel_send_operations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError("send operation was not persisted")
            return _send_operation_dict(row)

    def send_operation_ids_for_execution(self, limit: int = 20) -> list[str]:
        if not isinstance(limit, int) or limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT operation_id
                FROM channel_send_operations
                WHERE state = 'pending'
                  AND (lease_until IS NULL OR lease_until <= ?)
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def send_operation_ids_for_reconciliation(self, limit: int = 20) -> list[str]:
        """Return claimed sends that must be checked without invoking UI."""
        if not isinstance(limit, int) or limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT operation_id
                FROM channel_send_operations
                WHERE state = 'executing'
                  AND (lease_until IS NULL OR lease_until <= ?)
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def recover_send_operation_leases(self) -> int:
        """Release claims left by a previous Host process before restart."""
        with self._lock:
            updated = self._connection.execute(
                """
                UPDATE channel_send_operations
                SET lease_until = NULL
                WHERE state IN ('pending', 'executing')
                  AND lease_until IS NOT NULL
                """
            )
        return int(updated.rowcount)

    def send_operation_details(
        self, operation_id: str
    ) -> Optional[tuple[dict[str, object], Optional[int]]]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT operation_id, conversation_ref, payload_json, state, error,
                       channel_message_id, created_at, updated_at, baseline_sort_seq
                FROM channel_send_operations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
        if row is None:
            return None
        baseline = row["baseline_sort_seq"]
        return (
            _send_operation_dict(row),
            int(baseline) if baseline is not None else None,
        )

    def claim_send_operation(
        self,
        operation_id: str,
        baseline_sort_seq: int,
        lease_seconds: int = 60,
    ) -> Optional[SendOperationClaim]:
        if baseline_sort_seq < 0:
            raise ValueError("baseline sort sequence must be non-negative")
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be positive")
        now = datetime.now(timezone.utc)
        now_text = now.isoformat()
        lease_until = (now.timestamp() + lease_seconds)
        lease_text = datetime.fromtimestamp(
            lease_until, timezone.utc
        ).isoformat()
        with self._lock:
            row = self._connection.execute(
                """
                SELECT baseline_sort_seq
                FROM channel_send_operations
                WHERE operation_id = ?
                  AND state = 'pending'
                  AND (lease_until IS NULL OR lease_until <= ?)
                """,
                (operation_id, now_text),
            ).fetchone()
            if row is None:
                return None
            existing_baseline = row["baseline_sort_seq"]
            effective_baseline = (
                int(existing_baseline)
                if existing_baseline is not None
                else int(baseline_sort_seq)
            )
            updated = self._connection.execute(
                """
                UPDATE channel_send_operations
                SET state = 'executing', baseline_sort_seq = ?, attempts = attempts + 1,
                    lease_until = ?, updated_at = ?
                WHERE operation_id = ?
                  AND state = 'pending'
                  AND (lease_until IS NULL OR lease_until <= ?)
                """,
                (
                    effective_baseline,
                    lease_text,
                    now_text,
                    operation_id,
                    now_text,
                ),
            )
            if updated.rowcount != 1:
                return None
            claimed = self._connection.execute(
                """
                SELECT operation_id, conversation_ref, payload_json, state, error,
                       channel_message_id, created_at, updated_at
                FROM channel_send_operations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
        if claimed is None:
            return None
        return SendOperationClaim(
            operation=_send_operation_dict(claimed),
            baseline_sort_seq=effective_baseline,
        )

    def finish_send_operation(
        self,
        operation_id: str,
        state: str,
        *,
        error: Optional[str] = None,
        channel_message_id: Optional[str] = None,
    ) -> None:
        if state not in {"confirmed", "unknown", "failed"}:
            raise ValueError("invalid terminal send operation state")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            updated = self._connection.execute(
                """
                UPDATE channel_send_operations
                SET state = ?, error = ?, channel_message_id = ?,
                    updated_at = ?, lease_until = NULL
                WHERE operation_id = ?
                """,
                (state, error, channel_message_id, now, operation_id),
            )
            if updated.rowcount != 1:
                raise KeyError(operation_id)

    def get_send_operation(self, operation_id: str) -> Optional[dict[str, object]]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT operation_id, conversation_ref, payload_json, state, error,
                       channel_message_id, created_at, updated_at
                FROM channel_send_operations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
        return _send_operation_dict(row) if row is not None else None


def _parse_cursor(cursor: str) -> int:
    if not isinstance(cursor, str) or not cursor.isdigit():
        raise ValueError("afterCursor must be a non-negative integer cursor")
    return int(cursor)


def _event_dict(row: sqlite3.Row) -> dict[str, object]:
    event: dict[str, object] = {
        "eventId": row["event_id"],
        "cursor": str(row["cursor"]),
        "conversationRef": row["conversation_ref"],
        "channelMessageId": row["channel_message_id"],
        "senderRef": row["sender_ref"],
        "kind": row["kind"],
        "content": row["content"],
        "occurredAt": row["occurred_at"],
        "observedAt": row["observed_at"],
        "isSelf": bool(row["is_self"]),
        "mediaRef": row["media_ref"],
        "account": row["account"],
    }
    if row["file_name"] is not None:
        event["fileName"] = row["file_name"]
    if row["mime_type"] is not None:
        event["mimeType"] = row["mime_type"]
    if row["mentioned"] is not None:
        event["mentioned"] = bool(row["mentioned"])
    if row["reply_to_channel_message_id"] is not None:
        event["replyToChannelMessageId"] = row["reply_to_channel_message_id"]
    # 协议 v2：历史回溯标记只在 historical=true 时透出（缺省 = 实时事件）
    if row["historical"]:
        event["historical"] = True
    return event


def _send_operation_dict(row: sqlite3.Row) -> dict[str, object]:
    return {
        "operationId": row["operation_id"],
        "conversationRef": row["conversation_ref"],
        "payload": json.loads(row["payload_json"]),
        "state": row["state"],
        "error": row["error"],
        "channelMessageId": row["channel_message_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
