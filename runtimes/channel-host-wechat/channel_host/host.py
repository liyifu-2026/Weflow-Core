"""Reliable inbound-text adapter from wechatauto DB primitives to EventStore."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import re
import time
from typing import Callable, Optional
import xml.etree.ElementTree as ElementTree

from .event_store import ChannelObservation, EventStore


# Keep the channel adapter's group-prefix handling aligned with the existing
# wechatbot-new consumer. WeChat 4.x has emitted wxid_, gh_, and numeric
# sender prefixes across different group message variants.
GROUP_SENDER_RE = re.compile(r"^(wxid_[^\s:\n]+|gh_[^\s:\n]+|\d{6,}):\s*\n")


class WeChatChannelHost:
    """Poll WeChatDB directly and durably capture only text observations."""

    def __init__(
        self,
        db,
        event_store: EventStore,
        logger: Optional[Callable[[str], None]] = None,
        *,
        session_discovery_limit: int = 10000,
        message_chat_discovery_interval_seconds: float = 30.0,
    ):
        if session_discovery_limit < 1:
            raise ValueError("session_discovery_limit must be positive")
        if message_chat_discovery_interval_seconds < 0:
            raise ValueError(
                "message_chat_discovery_interval_seconds must be non-negative"
            )
        self.db = db
        self.event_store = event_store
        self.logger = logger or (lambda _message: None)
        self.session_discovery_limit = session_discovery_limit
        self.message_chat_discovery_interval_seconds = (
            message_chat_discovery_interval_seconds
        )
        self._self_ref: Optional[str] = None
        self._last_message_chat_discovery = 0.0

    def bootstrap(self) -> bool:
        if self.event_store.is_bootstrapped():
            return False
        sessions = self._session_rows()
        message_chats = self._message_chat_rows()

        high_water_marks = {
            str(row["username"]): 0
            for row in sessions
            if row.get("username")
        }
        discovered_keys = {
            str(row["username"]): _session_discovery_key(row)
            for row in sessions
            if row.get("username")
        }
        for row in message_chats:
            conversation_ref = str(row["username"])
            max_sort_seq = row.get("max_sort_seq")
            if max_sort_seq is None:
                max_sort_seq = self._current_high_water(conversation_ref)
            high_water_marks[conversation_ref] = max(
                high_water_marks.get(conversation_ref, 0), int(max_sort_seq)
            )
            discovered_keys.setdefault(
                conversation_ref,
                _message_chat_discovery_key(int(max_sort_seq)),
            )

        changed = self.event_store.bootstrap(
            high_water_marks,
            discovered_keys=discovered_keys,
        )
        self._last_message_chat_discovery = time.monotonic()
        return changed

    def poll_once(self) -> int:
        self.bootstrap()
        sessions = self._session_rows()
        message_chats = self._discover_message_chats_if_due()
        records = self._merge_discoveries(sessions, message_chats)
        captured = 0
        for conversation_ref, record in records.items():
            discovery_key = str(record["discovery_key"])
            max_sort_seq = record.get("max_sort_seq")
            checkpoint = self.event_store.source_checkpoint(conversation_ref)
            previous_key = self.event_store.discovered_key(conversation_ref)

            if checkpoint is None:
                high_water = (
                    int(max_sort_seq)
                    if max_sort_seq is not None
                    else self._current_high_water(conversation_ref)
                )
                self.event_store.ensure_conversation(
                    conversation_ref,
                    high_water,
                    discovery_key=discovery_key,
                )
                continue

            message_chat_advanced = (
                max_sort_seq is not None
                and int(max_sort_seq) > checkpoint
            )
            if previous_key is None and not message_chat_advanced:
                self.event_store.record_discovered(
                    conversation_ref, discovery_key
                )
                continue
            if previous_key == discovery_key and not message_chat_advanced:
                continue

            messages = self.db.get_new_messages(
                conversation_ref, since_seq=checkpoint, limit=200
            )
            for message in messages:
                sort_seq: Optional[int] = None
                try:
                    sort_seq = _required_int(message, "sort_seq")
                    if (
                        not _is_text_message(message)
                        and not _is_image_message(message)
                        and not _is_file_message(message)
                        and not _is_voice_message(message)
                        and not _is_emotion_message(message)
                    ):
                        self.event_store.advance_checkpoint(
                            conversation_ref, sort_seq
                        )
                        continue
                    observation = self._observation(conversation_ref, message)
                    if observation is None:
                        # A type-49 row that is not a parsable file attachment
                        # stays uncaptured; no file event is fabricated.
                        self.event_store.advance_checkpoint(
                            conversation_ref, sort_seq
                        )
                        continue
                    if self.event_store.capture(observation, sort_seq):
                        captured += 1
                except ValueError as error:
                    self.logger(
                        "ignored malformed WeChat message "
                        f"conversation={conversation_ref}: {error}"
                    )
                    # A malformed row with a valid source sequence is
                    # deliberately acknowledged; without a valid sequence it
                    # is reported and left for the next DB read.
                    if sort_seq is not None:
                        self.event_store.advance_checkpoint(conversation_ref, sort_seq)
            if len(messages) < 200:
                self.event_store.record_discovered(
                    conversation_ref, discovery_key
                )
        return captured

    def _observation(
        self, conversation_ref: str, message: dict
    ) -> Optional[ChannelObservation]:
        local_id = message.get("local_id")
        if local_id is None or str(local_id) == "":
            raise ValueError("missing local_id")
        is_image = _is_image_message(message)
        is_file = not is_image and _is_file_message(message)
        is_voice = not is_image and not is_file and _is_voice_message(message)
        is_emotion = not is_image and not is_file and not is_voice and _is_emotion_message(message)
        file_name: Optional[str] = None
        mime_type: Optional[str] = None
        if is_file:
            attachment = _parse_file_attachment(message.get("content"))
            if attachment is None:
                return None
            file_name, mime_type = attachment
            content: object = file_name
        elif is_image:
            content = "[image]"
        elif is_voice:
            raw_content = message.get("content")
            if not isinstance(raw_content, str):
                raise ValueError("voice content is not a string")
            # 微信「聊天中的语音消息自动转文字」开启时，转写文本会随消息行
            # 一起出现；未开启时内容是 [语音] 占位，此时 transcript 留空，
            # 由 Core 通过 mediaRef 走 SILK 下载 + ASR 备选路径。
            stripped = raw_content.strip()
            if (
                not stripped
                or _VOICE_PLACEHOLDER_RE.match(stripped)
                or "<voicemsg" in stripped.lower()
            ):
                content = ""
            else:
                content = raw_content
            mime_type = "audio/x-silk"
        elif is_emotion:
            raw_content = message.get("content")
            content = raw_content if isinstance(raw_content, str) else "[动画表情]"
        else:
            content = message.get("content")
            if not isinstance(content, str):
                raise ValueError("text content is not a string")
            if not content.strip():
                raise ValueError("empty text content")

        self_ref = self._get_self_ref()
        sender_id = message.get("sender_id")
        sender_ref, normalized_content = _sender_and_content(
            content, sender_id, self_ref
        )
        is_self = sender_id in (2, "2") or (
            self_ref is not None and str(sender_id) == self_ref
        )
        occurred_at = _timestamp(message.get("create_time"))
        local_id_text = str(local_id)
        event_id = f"wechat:{conversation_ref}:{local_id_text}"
        return ChannelObservation(
            event_id=event_id,
            conversation_ref=conversation_ref,
            channel_message_id=local_id_text,
            sender_ref=sender_ref,
            kind=(
                "image"
                if is_image
                else "file"
                if is_file
                else "voice"
                if is_voice
                else "emotion"
                if is_emotion
                else "text"
            ),
            content=normalized_content,
            occurred_at=occurred_at,
            observed_at=datetime.now(timezone.utc).isoformat(),
            is_self=is_self,
            media_ref=(
                f"wechat-media:v1:{hashlib.sha256(event_id.encode()).hexdigest()}"
                if is_image or is_file or is_voice or is_emotion
                else None
            ),
            file_name=file_name,
            mime_type=mime_type,
        )

    def _get_self_ref(self) -> Optional[str]:
        if self._self_ref is None:
            info = self.db.get_self_info()
            username = info.get("username") if isinstance(info, dict) else None
            self._self_ref = str(username) if username else ""
        return self._self_ref or None

    def _session_rows(self) -> list[dict]:
        rows = self.db.get_sessions(limit=self.session_discovery_limit)
        return [row for row in rows if isinstance(row, dict) and row.get("username")]

    def _message_chat_rows(self) -> list[dict]:
        rows = self.db.list_message_chats()
        result = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("username"):
                continue
            max_sort_seq = row.get("max_sort_seq")
            if max_sort_seq is not None:
                max_sort_seq = _required_int(
                    {"max_sort_seq": max_sort_seq}, "max_sort_seq"
                )
            result.append(
                {
                    "username": str(row["username"]),
                    "max_sort_seq": max_sort_seq,
                }
            )
        return result

    def _discover_message_chats_if_due(self) -> list[dict]:
        now = time.monotonic()
        if (
            now - self._last_message_chat_discovery
            < self.message_chat_discovery_interval_seconds
        ):
            return []
        rows = self._message_chat_rows()
        self._last_message_chat_discovery = now
        return rows

    @staticmethod
    def _merge_discoveries(
        sessions: list[dict], message_chats: list[dict]
    ) -> dict[str, dict[str, object]]:
        records: dict[str, dict[str, object]] = {}
        for row in sessions:
            conversation_ref = str(row["username"])
            records[conversation_ref] = {
                "discovery_key": _session_discovery_key(row),
                "max_sort_seq": None,
            }
        for row in message_chats:
            conversation_ref = str(row["username"])
            record = records.setdefault(
                conversation_ref,
                {
                    "discovery_key": _message_chat_discovery_key(
                        int(row["max_sort_seq"] or 0)
                    ),
                    "max_sort_seq": None,
                },
            )
            record["max_sort_seq"] = row.get("max_sort_seq")
        return records

    def _conversation_refs(self) -> list[str]:
        return [row["username"] for row in self._message_chat_rows()]

    def _current_high_water(self, conversation_ref: str) -> int:
        rows = self.db.get_messages(conversation_ref, limit=1)
        if not rows:
            return 0
        return _required_int(rows[0], "sort_seq")


def _is_text_message(message: dict) -> bool:
    return message.get("type") in ("文本", "text", 1) or message.get(
        "local_type"
    ) in ("文本", "text", 1)


def _is_image_message(message: dict) -> bool:
    return message.get("type") in ("图片", "image", 3) or message.get(
        "local_type"
    ) in ("图片", "image", 3)


def _is_file_message(message: dict) -> bool:
    return message.get("type") in ("文件/链接/卡片", "file", 49) or message.get(
        "local_type"
    ) in ("文件/链接/卡片", "file", 49)


def _is_voice_message(message: dict) -> bool:
    return message.get("type") in ("语音", "voice", 34) or message.get(
        "local_type"
    ) in ("语音", "voice", 34)


def _is_emotion_message(message: dict) -> bool:
    return message.get("type") in ("动画表情", "表情", "emotion", 47) or message.get(
        "local_type"
    ) in ("动画表情", "表情", "emotion", 47)


# 微信语音占位内容：未开启自动转文字时形如 "[语音]"、"[语音]12秒"、"[语音]5秒,未播放"
_VOICE_PLACEHOLDER_RE = re.compile(r"^\[语音\](?:\d+秒)?(?:,\s*未播放)?$")


def _parse_file_attachment(content: object) -> Optional[tuple[str, Optional[str]]]:
    """Parse a type-49 appmsg and return (file_name, mime_type) for file attachments.

    Returns None for anything that is not confidently a file attachment
    (merge-forward records, link cards, mini programs, unparsable XML, ...).
    """
    if isinstance(content, bytes):
        content = content.decode("utf-8", "replace")
    if not isinstance(content, str):
        return None
    stripped = content.strip()
    if not stripped.startswith("<"):
        return None
    try:
        root = ElementTree.fromstring(stripped)
    except ElementTree.ParseError:
        return None
    appmsg = root.find("appmsg")
    if appmsg is None:
        return None
    type_node = appmsg.find("type")
    if type_node is None or (type_node.text or "").strip() != "6":
        return None
    title_node = appmsg.find("title")
    raw_name = (title_node.text or "").strip() if title_node is not None else ""
    file_name = _sanitize_file_name(raw_name)
    if not file_name:
        return None
    mime_type, _ = mimetypes.guess_type(file_name)
    return file_name, mime_type


def _sanitize_file_name(name: str) -> str:
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:256]


def _required_int(message: dict, field: str) -> int:
    value = message.get(field)
    if isinstance(value, bool):
        raise ValueError(f"{field} is not an integer")
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"missing or invalid {field}") from None
    if result < 0:
        raise ValueError(f"{field} is negative")
    return result


def _sender_and_content(
    content: str, sender_id, self_ref: Optional[str]
) -> tuple[Optional[str], str]:
    match = GROUP_SENDER_RE.match(content)
    if match:
        return match.group(1), content[match.end() :]
    if sender_id in (None, 2, "2"):
        return (self_ref if sender_id in (2, "2") else None), content
    return str(sender_id), content


def _timestamp(value) -> Optional[str]:
    if value in (None, ""):
        return None
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid create_time") from None


def _session_discovery_key(row: dict) -> str:
    return json.dumps(
        {
            "last_time": row.get("last_time"),
            "summary": row.get("summary"),
            "last_sender": row.get("last_sender"),
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
        separators=(",", ":"),
    )


def _message_chat_discovery_key(max_sort_seq: int) -> str:
    return f"message-chat:{int(max_sort_seq)}"
