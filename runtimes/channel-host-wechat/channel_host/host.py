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

# 平台决定表情包不渲染截图，事件内容统一为文本「[表情包]<含义>」。
EMOTION_FALLBACK_TEXT = "[表情包]表情"
# 微信「拍一拍」系统消息捕获后的固定文案（ADR 之外的平台文案约定）。
PAT_EVENT_TEXT = "对方拍了拍你"


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
        account: Optional[str] = None,
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
        # ADR-0005：当前实例服务的微信账号（WECHAT_ACCOUNT），写入每个事件的
        # account 字段；未配置时保持 null，由 Core 回落 default。
        self.account = str(account).strip() or None if account else None
        self._self_ref: Optional[str] = None
        self._self_nickname: Optional[str] = None
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
                        and not _is_video_message(message)
                        and not _is_emotion_message(message)
                        and not _is_pat_message(message)
                        and not _is_quoted_reply_message(message)
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
        is_quoted_reply = _is_quoted_reply_message(message)
        # 拍一拍优先于文件分支：微信 4.x 把拍一拍以 type 49 appmsg 卡片
        # 落库（title=我拍了拍 "xxx"），若先判 file 会因解析不出附件被丢弃。
        is_pat = _is_pat_message(message)
        if is_pat:
            is_file = False
            is_quoted_reply = False
        is_video = not is_image and not is_file and _is_video_message(message)
        is_voice = not is_image and not is_file and not is_video and _is_voice_message(message)
        is_emotion = (
            not is_image
            and not is_file
            and not is_voice
            and _is_emotion_message(message)
        )
        file_name: Optional[str] = None
        mime_type: Optional[str] = None
        if is_file and not is_quoted_reply:
            attachment = _parse_file_attachment(message.get("content"))
            if attachment is None:
                return None
            file_name, mime_type = attachment
            content: object = file_name
        elif is_quoted_reply:
            # Quoted reply (type 49, appmsg type 57): treat as text with
            # replyToChannelMessageId extracted below.
            is_file = False
            reply_text = _extract_quoted_reply_text(message.get("content"))
            content = reply_text or ""
            if not isinstance(content, str) or not content.strip():
                # If we can't extract the text, skip this message.
                return None
        elif is_video:
            content = "[视频]"
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
            # 表情包文本化：DB 中的 content 多为加密容器/XML，仅尽力提取名称，
            # 无法识别时统一兜底为「[表情包]表情」。
            content = _emotion_text(message.get("content"))
        elif is_pat:
            pat_source = message.get("content")
            pat_text = (
                pat_source.decode("utf-8", "replace")
                if isinstance(pat_source, bytes)
                else pat_source
            )
            if not isinstance(pat_text, str):
                raise ValueError("pat message content is not a string")
            # appmsg 卡片形态：从 <title> 提取「我拍了拍 "Leaif"」原文；
            # type 10000 系统消息形态：保留原始「xxx 拍了拍 yyy」文案。
            title_text = _extract_pat_title(pat_text)
            content = title_text if title_text else PAT_EVENT_TEXT
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
                "video"
                if is_video
                else "image"
                if is_image
                else "file"
                if is_file
                else "voice"
                if is_voice
                else "emotion"
                if is_emotion
                else "pat"
                if is_pat
                else "text"
            ),
            content=normalized_content,
            occurred_at=occurred_at,
            observed_at=datetime.now(timezone.utc).isoformat(),
            is_self=is_self,
            media_ref=(
                f"wechat-media:v1:{hashlib.sha256(event_id.encode()).hexdigest()}"
                if is_image or is_file or is_voice or is_video or is_emotion
                else None
            ),
            file_name=file_name,
            mime_type=mime_type,
            account=self.account,
            mentioned=_detect_mentioned(
                normalized_content, is_self, self._get_self_nickname()
            ),
            reply_to_channel_message_id=_extract_reply_to_id(message),
        )

    def _get_self_ref(self) -> Optional[str]:
        if self._self_ref is None:
            info = self.db.get_self_info()
            username = info.get("username") if isinstance(info, dict) else None
            self._self_ref = str(username) if username else ""
            # Cache the nickname while we have the info dict.
            nick = info.get("nick_name") if isinstance(info, dict) else None
            self._self_nickname = str(nick).strip() if nick else ""
        return self._self_ref or None

    def _get_self_nickname(self) -> Optional[str]:
        """Return the current user's display nickname for @ detection."""
        if self._self_nickname is None:
            # Force _get_self_ref to populate both fields.
            self._get_self_ref()
        return self._self_nickname or None

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


def _is_video_message(message: dict) -> bool:
    return message.get("type") in ("视频", "video", 43) or message.get(
        "local_type"
    ) in ("视频", "video", 43)


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


def _is_system_message(message: dict) -> bool:
    return message.get("type") in ("系统消息", "system", 10000) or message.get(
        "local_type"
    ) in ("系统消息", "system", 10000)


# 微信「拍一拍」落库有两种形态：
# 1. type 10000 系统消息（经典路径）：「xxx」拍了拍你 / 你拍了拍「yyy」；
# 2. type 49 appmsg 卡片（微信 4.x 实测）：title 形如 `我拍了拍 "Leaif"`。
# 其余系统消息/卡片不捕获。
_PAT_KEYWORD = "拍了拍"


def _is_pat_message(message: dict) -> bool:
    if _is_system_message(message) and _PAT_KEYWORD in _message_text(message):
        return True
    if _is_file_message(message):
        text = _message_text(message)
        # appmsg 卡片：XML 里任何位置含「拍了拍」即视为拍一拍（title 为主）
        if text.strip().startswith("<") and _PAT_KEYWORD in text:
            return True
    return False


def _is_quoted_reply_message(message: dict) -> bool:
    """Type-49 appmsg with type 57 = quoted reply in WeChat 4.x."""
    if not _is_file_message(message):
        return False
    content = message.get("content")
    if isinstance(content, bytes):
        content = content.decode("utf-8", "replace")
    if not isinstance(content, str) or not content.strip().startswith("<"):
        return False
    try:
        root = ElementTree.fromstring(content.strip())
    except ElementTree.ParseError:
        return False
    appmsg = root.find("appmsg")
    if appmsg is None:
        return False
    type_node = appmsg.find("type")
    return (type_node is not None
            and (type_node.text or "").strip() == "57")


def _extract_quoted_reply_text(content: object) -> Optional[str]:
    """Extract the reply sender's text from a type-57 appmsg XML."""
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
    # The reply text is in <refermsg><displayname> or <title>.
    refermsg = appmsg.find("refermsg")
    if refermsg is not None:
        # <refermsg><content> holds the original message text.
        orig = refermsg.find("content")
        if orig is not None:
            value = (orig.text or "").strip()
            if value:
                return value
    # Fallback to <title> which sometimes carries the reply summary.
    title_node = appmsg.find("title")
    if title_node is not None:
        value = (title_node.text or "").strip()
        if value:
            return value
    return None


def _message_text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, bytes):
        return content.decode("utf-8", "replace")
    if isinstance(content, str):
        return content
    return ""


def _extract_pat_title(raw_content: object) -> Optional[str]:
    """从拍一拍 appmsg 卡片提取 <title> 原文（如 `我拍了拍 "Leaif"`）。

    type 10000 系统消息（非 XML）返回 None，由调用方回落固定文案。
    """
    if isinstance(raw_content, bytes):
        raw_content = raw_content.decode("utf-8", "replace")
    if not isinstance(raw_content, str):
        return None
    stripped = raw_content.strip()
    if not stripped.startswith("<"):
        return None
    try:
        root = ElementTree.fromstring(stripped)
    except ElementTree.ParseError:
        return None
    appmsg = root.find("appmsg")
    if appmsg is None:
        return None
    title_node = appmsg.find("title")
    if title_node is not None:
        value = (title_node.text or "").strip()
        if value and _PAT_KEYWORD in value:
            return value
    return None


# 微信摘要占位标签（不含语义，不能当表情名）
_EMOTION_PLACEHOLDER_RE = re.compile(r"^\[(?:动画表情|表情)\]$")
# <emoji> 节点里可能承载名称的属性（微信各版本字段不稳定，逐个尝试）
_EMOTION_NAME_ATTRS = ("name", "title", "description")


def _emotion_text(raw_content: object) -> str:
    name = _extract_emotion_name(raw_content)
    if not name:
        return EMOTION_FALLBACK_TEXT
    return f"[表情包]{_EMOTION_MEANINGS.get(name.lower(), name)}"


def _extract_emotion_name(raw_content: object) -> Optional[str]:
    if isinstance(raw_content, bytes):
        raw_content = raw_content.decode("utf-8", "replace")
    if not isinstance(raw_content, str):
        return None
    stripped = raw_content.strip()
    if not stripped:
        return None
    if stripped.startswith("<"):
        try:
            root = ElementTree.fromstring(stripped)
        except ElementTree.ParseError:
            return None
        for node in root.iter():
            tag = str(node.tag).rsplit("}", 1)[-1].lower()
            if tag != "emoji":
                continue
            for attr in _EMOTION_NAME_ATTRS:
                name = _clean_emotion_name(node.get(attr))
                if name:
                    return name
        return None
    if _EMOTION_PLACEHOLDER_RE.match(stripped):
        return None
    return _clean_emotion_name(stripped)


def _clean_emotion_name(value: Optional[str]) -> str:
    """归一并过滤候选表情名：去括号/控制字符，拒绝 md5、URL 等垃圾值。"""
    if not value:
        return ""
    name = value.strip()
    if len(name) >= 2 and name.startswith("[") and name.endswith("]"):
        name = name[1:-1].strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    if not name or len(name) > 24:
        return ""
    lowered = name.lower()
    if re.fullmatch(r"[0-9a-f]{16,}", lowered):
        return ""
    for marker in ("http", "/", "\\", "<", ">"):
        if marker in lowered:
            return ""
    return name


# 常用表情名 → 规范含义。键覆盖旧树九分类英文目录名
# （wxbot/wechatbot-new/emojis：happy/sad/angry 等）与微信常见内置表情名；
# 未收录的名字按原文透出为 [表情包]<名字>。
_EMOTION_MEANINGS = {
    # 九分类目录名
    "happy": "开心",
    "sad": "难过",
    "angry": "生气",
    "confused": "困惑",
    "evasive": "回避",
    "loved": "喜爱",
    "reminded": "提醒",
    "surprised": "惊讶",
    "tired": "疲惫",
    # 微信内置小黄脸与常用别名
    "微笑": "微笑",
    "撇嘴": "难过",
    "色": "花痴",
    "发呆": "发呆",
    "得意": "得意",
    "流泪": "流泪",
    "害羞": "害羞",
    "睡": "困了",
    "大哭": "大哭",
    "尴尬": "尴尬",
    "发怒": "生气",
    "调皮": "调皮",
    "呲牙": "开心",
    "难过": "难过",
    "囧": "尴尬",
    "抓狂": "抓狂",
    "吐": "吐",
    "偷笑": "偷笑",
    "可爱": "可爱",
    "白眼": "无语",
    "饥饿": "饥饿",
    "困": "困了",
    "惊恐": "惊恐",
    "流汗": "流汗",
    "憨笑": "憨笑",
    "悠闲": "悠闲",
    "奋斗": "奋斗",
    "咒骂": "生气",
    "疑问": "疑问",
    "晕": "晕",
    "衰": "衰",
    "再见": "再见",
    "擦汗": "擦汗",
    "鼓掌": "鼓掌",
    "坏笑": "坏笑",
    "鄙视": "鄙视",
    "委屈": "委屈",
    "快哭了": "快哭了",
    "亲亲": "亲亲",
    "可怜": "可怜",
    "笑脸": "开心",
    "开心": "开心",
    "大笑": "大笑",
    "抱抱": "抱抱",
    "点赞": "点赞",
    "握手": "握手",
    "胜利": "胜利",
    "抱拳": "抱拳",
    "爱心": "爱心",
    "心碎": "心碎",
    "玫瑰": "玫瑰",
    "蛋糕": "蛋糕",
    "咖啡": "咖啡",
    "啤酒": "干杯",
    "猪头": "猪头",
    "月亮": "晚安",
    "太阳": "早安",
}


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


def _detect_mentioned(
    content: str, is_self: bool, self_nickname: Optional[str]
) -> Optional[bool]:
    """Detect whether the current user was @-mentioned in a group message.

    WeChat 4.x embeds @ mentions as ``@nickname`` in the message text.
    Only meaningful for inbound (non-self) messages; self messages and
    conversations without a known nickname yield ``None``.
    """
    if is_self:
        return None
    if not self_nickname:
        return None
    if not isinstance(content, str) or not content:
        return None
    # Match @nickname at word boundaries; WeChat inserts a non-breaking
    # space or regular space after the nickname token.
    pattern = f"@{re.escape(self_nickname)}"
    return bool(re.search(pattern, content))


def _extract_reply_to_id(message: Optional[dict]) -> Optional[str]:
    """Parse a type-49 appmsg XML to extract the quoted reply's local_id.

    WeChat 4.x stores quoted replies as type-49 rows whose XML contains a
    ``<refermsg>`` node with ``<localid>`` inside it.  Returns ``None`` for
    anything that is not a parsable quoted-reply reference.
    """
    if message is None:
        return None
    content = message.get("content")
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
    # Type 57 = quoted reply in WeChat 4.x appmsg protocol.
    type_node = appmsg.find("type")
    type_text = (type_node.text or "").strip() if type_node is not None else ""
    if type_text != "57":
        return None
    refermsg = appmsg.find("refermsg")
    if refermsg is None:
        return None
    localid_node = refermsg.find("localid")
    if localid_node is not None:
        value = (localid_node.text or "").strip()
        if value:
            return value
    # Fallback: some versions use <chch> with a local_id attribute or
    # embed the ID in a different child node.
    for child in refermsg:
        tag = str(child.tag).rsplit("}", 1)[-1].lower()
        if "local" in tag and "id" in tag:
            value = (child.text or "").strip()
            if value:
                return value
    return None
