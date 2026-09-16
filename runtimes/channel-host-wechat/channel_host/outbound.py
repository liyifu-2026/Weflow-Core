"""Durable message-send execution for the local WeChat Channel Host."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Callable, Optional, Protocol

from .channel_protocol import SEND_KINDS
from .event_store import EventStore
from .protocol_normalize import mention_contact_refs, reply_target_id


@dataclass(frozen=True)
class SendAttempt:
    state: str
    error: Optional[str] = None


class ContactResolutionError(RuntimeError):
    """The durable channel identity could not be mapped to a GUI target."""


# A GUI send may already have succeeded while the WeChat database is still
# catching up. Reconcile that narrow window by reading the original operation
# only; never create a replacement operation or invoke the GUI a second time.
#
# 窗口取值以实测为准（2026-09-16 X230）：消息写进微信本地库后，我们的解密
# 缓存要等微信刷盘/文件元数据更新才看得见——实测发送完成 +7s 写库、+17.7s
# 才可读（滞后约 11s）。原 8s 窗口必然超时，把已送达的消息记成 unknown。
AMBIGUOUS_RECONCILIATION_SECONDS = 30.0
AMBIGUOUS_RECONCILIATION_INTERVAL_SECONDS = 1.0


class MessageSender(Protocol):
    def current_high_water(self, conversation_ref: str) -> int:
        ...

    def find_self_text_after(
        self, conversation_ref: str, text: str, baseline_sort_seq: int
    ) -> Optional[str]:
        ...

    def send_text(self, conversation_ref: str, text: str) -> SendAttempt:
        ...

    def send_image(self, conversation_ref: str, path: str) -> SendAttempt:
        ...

    def send_file(self, conversation_ref: str, path: str) -> SendAttempt:
        ...

    def send_reply(
        self, conversation_ref: str, text: str, target_message_id: Optional[str] = None
    ) -> SendAttempt:
        ...

    def send_at(
        self, conversation_ref: str, members: list[str], text: str
    ) -> SendAttempt:
        ...

    def send_tickle(self, conversation_ref: str) -> SendAttempt:
        ...

    def send_recall(self, conversation_ref: str) -> SendAttempt:
        ...


class WeChatChannelSender:
    """Adapt WeChatDB and WeChatGUI to the durable send executor."""

    def __init__(self, db, gui_factory: Optional[Callable[[], object]] = None):
        self.db = db
        self._gui_factory = gui_factory or _default_gui_factory
        self._gui = None

    def current_high_water(self, conversation_ref: str) -> int:
        rows = self.db.get_messages(conversation_ref, limit=1)
        if not rows:
            return 0
        return _sort_seq(rows[0])

    def find_self_text_after(
        self, conversation_ref: str, text: str, baseline_sort_seq: int
    ) -> Optional[str]:
        rows = self.db.get_messages(conversation_ref, limit=200)
        for row in rows:
            if not self._is_self_row(row, conversation_ref):
                continue
            if row.get("content") != text:
                continue
            if _sort_seq(row) <= baseline_sort_seq:
                continue
            local_id = row.get("local_id")
            if local_id is not None:
                return str(local_id)
        return None

    def _is_self_row(self, row: dict, conversation_ref: str) -> bool:
        """该行是否为本机发出——走 DB 层自适应判定，不写死「2=自己」。

        两台实机语义相反（开发机自己=2、X230 自己=1 而对端=2），写死常量会让
        发送对账在 X230 上永远匹配不到，把已送达的消息记成 unknown。
        """
        check = getattr(self.db, "is_self_sender", None)
        if callable(check):
            try:
                return bool(check(row.get("sender_id"), conversation_ref))
            except TypeError:
                return bool(check(row.get("sender_id")))
        return row.get("sender_id") in (2, "2")

    def send_text(self, conversation_ref: str, text: str) -> SendAttempt:
        try:
            # ``conversation_ref`` is an opaque, durable channel identity. It
            # must never be typed into the WeChat search box: the GUI expects
            # a visible nickname/remark such as "Leaif". Resolve the target
            # at the Driver seam while keeping the Core/channel contract
            # stable on the wxid.
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            result = self._gui.send_msg(text, target_name, verify=True)
        except Exception as error:
            return self._fail_with_gui_reset(error)
        if _is_verified_success(result):
            return SendAttempt("confirmed")
        if not isinstance(result, dict):
            return SendAttempt("unknown", "wechat_send_not_confirmed")
        if result.get("status") not in {"失败", "failed"}:
            return SendAttempt("unknown", "wechat_send_not_confirmed")
        message = result.get("message")
        error = str(message or "wechat_send_not_confirmed")
        if _is_ambiguous_send_result(error):
            return SendAttempt("unknown", error)
        return SendAttempt("failed", error)

    def send_image(self, conversation_ref: str, path: str) -> SendAttempt:
        try:
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            result = self._gui.send_image(path, target_name, verify=True)
        except Exception as error:
            return self._fail_with_gui_reset(error)
        return _gui_result_to_attempt(result)

    def send_file(self, conversation_ref: str, path: str) -> SendAttempt:
        try:
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            result = self._gui.send_file(path, target_name, verify=True)
        except Exception as error:
            return self._fail_with_gui_reset(error)
        return _gui_result_to_attempt(result)

    def send_reply(
        self, conversation_ref: str, text: str, target_message_id: Optional[str] = None
    ) -> SendAttempt:
        try:
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        # 参照 replica：GUI 仅能回复最新可见消息；若显式指定非最新 local_id，拒绝而非静默回最新
        if target_message_id is not None and str(target_message_id).strip():
            try:
                rows = self.db.get_messages(conversation_ref, limit=1)
                latest = str(rows[0].get("local_id")) if rows and rows[0].get("local_id") is not None else None
                if latest is not None and str(target_message_id).strip() != latest:
                    return SendAttempt("failed", "reply_target_not_latest")
            except Exception:
                pass
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            result = self._gui.reply_msg(text, target_name, verify=True)
        except Exception as error:
            return self._fail_with_gui_reset(error)
        return _gui_result_to_attempt(result)

    def send_at(
        self, conversation_ref: str, members: list[str], text: str
    ) -> SendAttempt:
        try:
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        resolved = [self._resolve_member_name(member) for member in members]
        if not resolved:
            return SendAttempt("failed", "at_requires_at_least_one_member")
        # 成员资格预检（适配器内优化，不改协议）：roster 可用时，@ 一个不在
        # 群里的成员引用直接映射为 mention_member_not_found，省掉一次注定
        # 失败的 UI 弹层操作（抢窗口、耗时长）。显示名 token 不做预检
        # （名册按 wxid 记录，无法反查显示名）；roster 读取失败/能力缺失
        # 一律跳过预检，保持原有 UI 路径兜底。
        member_refs = self._group_member_refs(conversation_ref)
        if member_refs is not None:
            prefix = "contact:channel:"
            for member in members:
                token = member.strip()
                if not token.startswith(prefix):
                    continue
                raw_ref = token[len(prefix) :].rsplit(":", 1)[-1]
                if raw_ref and raw_ref not in member_refs:
                    return SendAttempt("failed", "mention_member_not_found")
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            # 参照 replica：循环逐个 @ 成员（弹层 OCR 选人），任一失败即失败
            last_result = None
            for member in resolved:
                last_result = self._gui.at_member(member, text if member == resolved[-1] else "", who=target_name, verify=True)
                if not _is_verified_success(last_result):
                    # 成员未在群弹层命中时按 failed 透传，便于 Core 映射为 mention_member_not_found
                    msg = last_result.get("message") if isinstance(last_result, dict) else None
                    text_msg = str(msg or "")
                    if "未找到" in text_msg or "not found" in text_msg.lower():
                        return SendAttempt("failed", "mention_member_not_found")
                    return _gui_result_to_attempt(last_result)
            return _gui_result_to_attempt(last_result) if last_result is not None else SendAttempt("failed", "mention_member_not_found")
        except Exception as error:
            return self._fail_with_gui_reset(error)

    def send_tickle(self, conversation_ref: str) -> SendAttempt:
        try:
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            # 按用户要求参照 replica：群聊按像素重心选 friend 行头像附近右键，再 OCR 定位「拍一拍」
            # 复用 uia_driver.poke 的双次重试 + DPI 物理像素一致性；失败细分错误码透传
            uia = self._gui._get_uia()
            if uia is None:
                return SendAttempt("failed", "uia_driver_unavailable_for_tickle")
            ok = uia.poke(target_name)
        except Exception as error:
            return self._fail_with_gui_reset(error)
        if ok:
            return SendAttempt("confirmed")
        return SendAttempt("failed", "tickle_not_confirmed")

    def send_recall(self, conversation_ref: str) -> SendAttempt:
        try:
            target_name = self._resolve_gui_target(conversation_ref)
        except ContactResolutionError as error:
            return SendAttempt("failed", str(error))
        try:
            if self._gui is None:
                self._gui = self._gui_factory()
            uia = self._gui._get_uia()
            if uia is None:
                return SendAttempt("failed", "recall_unsupported")
            ok = uia.recall_last_message(target_name)
        except Exception as error:
            return self._fail_with_gui_reset(error)
        if ok:
            return SendAttempt("confirmed")
        return SendAttempt("failed", "recall_window_expired")

    def _fail_with_gui_reset(self, error: Exception) -> SendAttempt:
        """Send-path exception: drop the cached GUI session.

        WeChat restarts / window closes invalidate the UIA handles the cached
        WeChatGUI holds (e.g. COM ``事件无法调用任何订户``). Rebuilding lazily
        on the next send keeps the host self-healing instead of failing every
        send until a manual restart.
        """
        self._gui = None
        return SendAttempt("unknown", _error_text(error))

    def _resolve_gui_target(self, conversation_ref: str) -> str:
        """Map an opaque conversation ref to the name visible in WeChat UI.

        Prefer the DB nickname/remark. We must only drive the WeChat search
        box with a name we could actually resolve; typing a raw wxid (or an
        account-qualified/self identity) as the search target is unreliable
        and can drive the GUI against the wrong window. `get_nickname`
        returns the input unchanged when no contact record exists, so the
        resolver reports failure instead of falling back to a wxid search.
        Whether a send is allowed at all is still controlled by the Core
        whitelist (contact profile agentEnabled / whitelist).
        """
        get_nickname = getattr(self.db, "get_nickname", None)
        if not callable(get_nickname):
            raise ContactResolutionError(
                f"无法解析发送目标：{conversation_ref}（名称解析器不可用）"
            )
        try:
            name = get_nickname(conversation_ref)
        except Exception as error:
            raise ContactResolutionError(
                f"无法解析发送目标：{conversation_ref}（{error}）"
            ) from error
        if isinstance(name, str) and name.strip() and name.strip() != conversation_ref:
            return name.strip()
        raise ContactResolutionError(
            f"未找到可发送目标 {conversation_ref} 的昵称，已取消发送（不按 wxid 搜索）"
        )

    def _group_member_refs(self, conversation_ref: str) -> Optional[set[str]]:
        """群成员 wxid 集合（只读 contact.db 名册）；不可用时返回 None。

        仅对群会话（``xxx@chatroom``）生效。任何异常都吞掉并返回 None——
        预检是纯优化，绝不阻断发送路径。
        """
        if not conversation_ref.endswith("@chatroom"):
            return None
        get_members = getattr(self.db, "get_group_members", None)
        if not callable(get_members):
            return None
        try:
            members = get_members(conversation_ref)
        except Exception:
            return None
        refs = set()
        for item in members or []:
            username = item.get("username") if isinstance(item, dict) else None
            if isinstance(username, str) and username:
                refs.add(username)
        return refs or None

    def _resolve_member_name(self, member: str) -> str:
        """Map a mention member reference to a GUI-visible member token.

        The Core layer treats contact refs as opaque. A ref shaped like
        ``contact:channel:[<account>:]<ref>`` carries the raw channel ref
        (wxid / chatroom id) in its last segment; unwrap it and prefer the
        contact-db nickname/remark, falling back to the raw ref. Non-ref
        tokens (display names chosen by the operator UI) pass through.
        """
        token = member.strip()
        if not token.startswith("contact:channel:"):
            return token
        raw_ref = token[len("contact:channel:") :].rsplit(":", 1)[-1]
        get_nickname = getattr(self.db, "get_nickname", None)
        if not callable(get_nickname):
            return raw_ref
        try:
            name = get_nickname(raw_ref)
        except Exception:
            return raw_ref
        if isinstance(name, str) and name.strip():
            return name.strip()
        return raw_ref


def process_send_operations(
    event_store: EventStore,
    sender: MessageSender,
    limit: int = 20,
) -> int:
    """Execute and reconcile a bounded batch without replacement operation IDs.

    A pending operation records a source watermark before UI automation starts.
    Once claimed, it becomes ``executing``. On restart, executing operations
    are reconciliation-only: the executor checks DB evidence and never invokes
    UI automation again.
    """

    processed = 0
    operation_ids = event_store.send_operation_ids_for_reconciliation(limit)
    operation_ids.extend(event_store.send_operation_ids_for_execution(limit))
    for operation_id in operation_ids:
        details = event_store.send_operation_details(operation_id)
        if details is None:
            continue
        operation, existing_baseline = details
        payload = operation.get("payload")
        if not isinstance(payload, dict):
            event_store.finish_send_operation(
                operation_id,
                "failed",
                error="missing_payload",
            )
            processed += 1
            continue
        kind = payload.get("kind")
        if kind not in _SUPPORTED_SEND_KINDS:
            event_store.finish_send_operation(
                operation_id,
                "failed",
                error=f"unsupported_send_kind:{kind}",
            )
            processed += 1
            continue
        conversation_ref = operation.get("conversationRef")
        if not isinstance(conversation_ref, str):
            event_store.finish_send_operation(
                operation_id,
                "failed",
                error="malformed_send_operation",
            )
            processed += 1
            continue

        if operation.get("state") == "executing":
            if existing_baseline is None:
                event_store.finish_send_operation(
                    operation_id,
                    "unknown",
                    error="missing_send_baseline_for_reconciliation",
                )
                processed += 1
                continue
            # Only text sends can be reconciled via DB text search.
            # Non-text kinds (image/file/reply/mention/poke) rely on the
            # GUI verify=True path; after a crash we cannot confirm them.
            if kind != "text":
                event_store.finish_send_operation(
                    operation_id,
                    "unknown",
                    error="non_text_send_not_reconcilable",
                )
                processed += 1
                continue
            text = payload.get("text")
            if not isinstance(text, str):
                event_store.finish_send_operation(
                    operation_id,
                    "unknown",
                    error="malformed_text_payload_for_reconciliation",
                )
                processed += 1
                continue
            try:
                existing_message_id = sender.find_self_text_after(
                    conversation_ref, text, existing_baseline
                )
            except Exception as error:
                event_store.finish_send_operation(
                    operation_id,
                    "unknown",
                    error=f"send_reconciliation_failed:{_error_text(error)}",
                )
            else:
                if existing_message_id is not None:
                    event_store.finish_send_operation(
                        operation_id,
                        "confirmed",
                        channel_message_id=existing_message_id,
                    )
                else:
                    event_store.finish_send_operation(
                        operation_id,
                        "unknown",
                        error="send_not_confirmed_after_crash",
                    )
            processed += 1
            continue

        baseline = (
            existing_baseline
            if existing_baseline is not None
            else sender.current_high_water(conversation_ref)
        )
        claim = event_store.claim_send_operation(operation_id, baseline)
        if claim is None:
            continue

        # Pre-send reconciliation: only applicable to text sends.
        if kind == "text":
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                event_store.finish_send_operation(
                    operation_id,
                    "failed",
                    error="text_payload_empty",
                )
                processed += 1
                continue
            try:
                existing_message_id = sender.find_self_text_after(
                    conversation_ref, text, claim.baseline_sort_seq
                )
            except Exception as error:
                event_store.finish_send_operation(
                    operation_id,
                    "unknown",
                    error=f"send_reconciliation_failed:{_error_text(error)}",
                )
                processed += 1
                continue
            if existing_message_id is not None:
                event_store.finish_send_operation(
                    operation_id,
                    "confirmed",
                    channel_message_id=existing_message_id,
                )
                processed += 1
                continue

        attempt = _dispatch_send(sender, conversation_ref, payload)
        if attempt.state == "confirmed":
            # For text sends, try to find the channel message ID via DB.
            # For non-text sends, the GUI verify=True already confirmed.
            channel_message_id = None
            if kind == "text":
                text = payload.get("text")
                try:
                    channel_message_id = sender.find_self_text_after(
                        conversation_ref, text, claim.baseline_sort_seq
                    )
                except Exception:
                    channel_message_id = None
            event_store.finish_send_operation(
                operation_id,
                "confirmed",
                channel_message_id=channel_message_id,
            )
        elif attempt.state == "unknown":
            if kind == "text":
                text = payload.get("text")
                channel_message_id = _reconcile_ambiguous_send(
                    sender,
                    conversation_ref,
                    text,
                    claim.baseline_sort_seq,
                )
                if channel_message_id is not None:
                    event_store.finish_send_operation(
                        operation_id,
                        "confirmed",
                        channel_message_id=channel_message_id,
                    )
                else:
                    event_store.finish_send_operation(
                        operation_id,
                        "unknown",
                        error=attempt.error or "wechat_send_not_confirmed",
                    )
            else:
                event_store.finish_send_operation(
                    operation_id,
                    "unknown",
                    error=attempt.error or "wechat_send_not_confirmed",
                )
        elif attempt.state == "failed":
            event_store.finish_send_operation(
                operation_id,
                attempt.state,
                error=attempt.error or "wechat_send_not_confirmed",
            )
        else:
            event_store.finish_send_operation(
                operation_id,
                "unknown",
                error="invalid_sender_result",
            )
        processed += 1
    return processed


def _reconcile_ambiguous_send(
    sender: MessageSender,
    conversation_ref: str,
    text: str,
    baseline_sort_seq: int,
) -> Optional[str]:
    deadline = time.monotonic() + AMBIGUOUS_RECONCILIATION_SECONDS
    while True:
        try:
            message_id = sender.find_self_text_after(
                conversation_ref, text, baseline_sort_seq
            )
        except Exception:
            message_id = None
        if message_id is not None:
            return message_id
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(AMBIGUOUS_RECONCILIATION_INTERVAL_SECONDS, remaining))


def _default_gui_factory():
    from wechatauto import WeChatGUI

    return WeChatGUI()


def _sort_seq(row: dict) -> int:
    value = row.get("sort_seq")
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ValueError("message sort_seq is invalid") from None
    if result < 0:
        raise ValueError("message sort_seq is negative")
    return result


def _error_text(error: Exception) -> str:
    text = str(error).strip()
    return text[:500] or error.__class__.__name__


def _is_verified_success(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    return result.get("status") in {"成功", "success", "confirmed"}


def _is_ambiguous_send_result(message: str) -> bool:
    return any(
        marker in message
        for marker in (
            "已操作发送",
            "数据库未确认",
            "未确认",
            "verification_timeout",
        )
    )


def _gui_result_to_attempt(result: object) -> SendAttempt:
    """Convert a WeChatGUI WxResponse to a SendAttempt."""
    if _is_verified_success(result):
        return SendAttempt("confirmed")
    if not isinstance(result, dict):
        return SendAttempt("unknown", "wechat_send_not_confirmed")
    if result.get("status") not in {"失败", "failed"}:
        return SendAttempt("unknown", "wechat_send_not_confirmed")
    message = result.get("message")
    error = str(message or "wechat_send_not_confirmed")
    if _is_ambiguous_send_result(error):
        return SendAttempt("unknown", error)
    return SendAttempt("failed", error)


# 协议 v3 已移除出站 voice；此处从协议常量派生（ADR-0010），不再手抄。
_SUPPORTED_SEND_KINDS = frozenset(SEND_KINDS)


def _dispatch_send(
    sender: MessageSender,
    conversation_ref: str,
    payload: dict,
) -> SendAttempt:
    """Route a send payload to the appropriate sender method by kind."""
    kind = payload.get("kind")
    if kind == "text":
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return SendAttempt("failed", "text_payload_empty")
        return sender.send_text(conversation_ref, text)
    if kind == "image":
        path = payload.get("path")
        if not isinstance(path, str) or not path.strip():
            return SendAttempt("failed", "image_path_required")
        return sender.send_image(conversation_ref, path)
    if kind == "file":
        path = payload.get("path")
        if not isinstance(path, str) or not path.strip():
            return SendAttempt("failed", "file_path_required")
        return sender.send_file(conversation_ref, path)
    if kind == "reply":
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return SendAttempt("failed", "reply_text_required")
        return sender.send_reply(
            conversation_ref, text, reply_target_id(payload)
        )
    if kind == "mention":
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return SendAttempt("failed", "mention_text_required")
        members = mention_contact_refs(payload)
        if not members:
            return SendAttempt("failed", "mention_members_required")
        return sender.send_at(conversation_ref, members, text)
    if kind == "poke":
        return sender.send_tickle(conversation_ref)
    if kind == "recall":
        return sender.send_recall(conversation_ref)
    return SendAttempt("failed", f"unsupported_send_kind:{kind}")
