"""Durable text-send execution for the local WeChat Channel Host."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Callable, Optional, Protocol

from .event_store import EventStore


@dataclass(frozen=True)
class SendAttempt:
    state: str
    error: Optional[str] = None


class ContactResolutionError(RuntimeError):
    """The durable channel identity could not be mapped to a GUI target."""


# A GUI send may already have succeeded while the WeChat database is still
# catching up. Reconcile that narrow window by reading the original operation
# only; never create a replacement operation or invoke the GUI a second time.
AMBIGUOUS_RECONCILIATION_SECONDS = 8.0
AMBIGUOUS_RECONCILIATION_INTERVAL_SECONDS = 1.0


class TextSender(Protocol):
    def current_high_water(self, conversation_ref: str) -> int:
        ...

    def find_self_text_after(
        self, conversation_ref: str, text: str, baseline_sort_seq: int
    ) -> Optional[str]:
        ...

    def send_text(self, conversation_ref: str, text: str) -> SendAttempt:
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
            if row.get("sender_id") not in (2, "2"):
                continue
            if row.get("content") != text:
                continue
            if _sort_seq(row) <= baseline_sort_seq:
                continue
            local_id = row.get("local_id")
            if local_id is not None:
                return str(local_id)
        return None

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
            return SendAttempt("unknown", _error_text(error))
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

    def _resolve_gui_target(self, conversation_ref: str) -> str:
        """Map an opaque conversation ref to the name visible in WeChat UI."""
        get_nickname = getattr(self.db, "get_nickname", None)
        if not callable(get_nickname):
            raise ContactResolutionError("channel_contact_unresolved")
        try:
            name = get_nickname(conversation_ref)
        except Exception as error:
            raise ContactResolutionError("channel_contact_resolution_failed") from error
        if isinstance(name, str) and name.strip() and name.strip() != conversation_ref:
            return name.strip()
        raise ContactResolutionError("channel_contact_unresolved")


def process_send_operations(
    event_store: EventStore,
    sender: TextSender,
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
        if not isinstance(payload, dict) or payload.get("kind") != "text":
            event_store.finish_send_operation(
                operation_id,
                "failed",
                error="only_text_send_operations_are_supported",
            )
            processed += 1
            continue
        text = payload.get("text")
        conversation_ref = operation.get("conversationRef")
        if not isinstance(text, str) or not isinstance(conversation_ref, str):
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

        attempt = sender.send_text(conversation_ref, text)
        if attempt.state == "confirmed":
            try:
                channel_message_id = sender.find_self_text_after(
                    conversation_ref, text, claim.baseline_sort_seq
                )
            except Exception:
                # The sender already returned a verified success. A follow-up
                # lookup is useful for the channel ID, but must not turn a
                # confirmed send back into a retryable operation.
                channel_message_id = None
            event_store.finish_send_operation(
                operation_id,
                "confirmed",
                channel_message_id=channel_message_id,
            )
        elif attempt.state == "unknown":
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
    sender: TextSender,
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
