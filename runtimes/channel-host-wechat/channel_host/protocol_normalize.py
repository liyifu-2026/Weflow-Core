"""ADR-0006 wire payload normalisation for send operations.

Core sends payload fields per ``@weflow-leaif/contracts`` (ADR-0006):
``replyToChannelMessageId`` and ``mentionContactRefs``. The WeChat host
internally used legacy fields (``target_message_id`` / ``members``), which
made every contract-conformant reply/mention POST fail validation with
HTTP 400 — and because the outbound poller processes messages in order,
one rejected payload froze the whole queue (head-of-line blocking).

This module accepts both spellings on the wire and stores/returns the
contract fields, so Core's strict response schema keeps parsing while the
dispatch layer maps to legacy kwargs.
"""

from __future__ import annotations

from typing import Mapping, Optional


def clean_string_list(value: object) -> Optional[list[str]]:
    """Return a list of non-empty strings, or None when nothing usable."""
    if not isinstance(value, (list, tuple)):
        return None
    items = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return items or None


def normalize_reply_fields(payload: Mapping[str, object]) -> dict[str, object]:
    """Return a reply payload keyed by the contract ``replyToChannelMessageId``.

    Legacy ``target_message_id`` is accepted and converted; the contract
    field wins when both are present.
    """
    normalized = dict(payload)
    target = payload.get("replyToChannelMessageId")
    if not isinstance(target, str) or not target.strip():
        legacy = payload.get("target_message_id")
        target = legacy if isinstance(legacy, str) else None
    if isinstance(target, str) and target.strip():
        normalized["replyToChannelMessageId"] = target.strip()
    else:
        normalized.pop("replyToChannelMessageId", None)
    normalized.pop("target_message_id", None)
    return normalized


def normalize_mention_fields(payload: Mapping[str, object]) -> dict[str, object]:
    """Return a mention payload keyed by the contract ``mentionContactRefs``.

    Legacy ``members`` is accepted and converted; the contract field wins
    when both are present.
    """
    normalized = dict(payload)
    refs = clean_string_list(payload.get("mentionContactRefs"))
    if refs is None:
        refs = clean_string_list(payload.get("members"))
    if refs is not None:
        normalized["mentionContactRefs"] = refs
    else:
        normalized.pop("mentionContactRefs", None)
    normalized.pop("members", None)
    return normalized


def normalize_send_payload(payload: Mapping[str, object]) -> dict[str, object]:
    """Normalise any send payload to the ADR-0006 contract field names."""
    kind = payload.get("kind")
    if kind == "reply":
        return normalize_reply_fields(payload)
    if kind == "mention":
        return normalize_mention_fields(payload)
    return dict(payload)


def reply_target_id(payload: Mapping[str, object]) -> Optional[str]:
    """The reply target channel message id, if any (contract field)."""
    target = payload.get("replyToChannelMessageId")
    if isinstance(target, str) and target.strip():
        return target.strip()
    return None


def mention_contact_refs(payload: Mapping[str, object]) -> Optional[list[str]]:
    """Member reference tokens from a mention payload (contract field)."""
    return clean_string_list(payload.get("mentionContactRefs"))
