"""Versioned HTTP/JSON boundary for the local Channel Host."""

from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
from threading import Thread
from typing import Callable, Optional
import urllib.parse
from urllib.parse import parse_qs, unquote, urlsplit

from .event_store import EventStore, SendOperationConflict
from .media import ChannelMediaReadResult


class ChannelHostHttpServer:
    def __init__(
        self,
        event_store: EventStore,
        token: str,
        host: str = "127.0.0.1",
        port: int = 0,
        wechat_process_alive: Optional[Callable[[], bool]] = None,
        media_resolver: Optional[Callable[[str], ChannelMediaReadResult]] = None,
        contact_reader: Optional[Callable[[str, int], dict]] = None,
        key_refresh: Optional[Callable[[], bool]] = None,
    ):
        if not token:
            raise ValueError("channel host token is required")
        self.event_store = event_store
        self.token = token
        self.host = host
        self.port = port
        self.wechat_process_alive = wechat_process_alive
        self.media_resolver = media_resolver
        self.contact_reader = contact_reader
        self.key_refresh = key_refresh
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[Thread] = None

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("channel host is not started")
        return f"http://{self.host}:{self._server.server_address[1]}"

    def start(self) -> None:
        if self._server is not None:
            return
        runtime = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
                runtime._handle_get(self)

            def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
                runtime._handle_post(self)

            def log_message(self, _format: str, *_args) -> None:
                return

        self._server = ThreadingHTTPServer((self.host, self.port), Handler)
        self._thread = Thread(
            target=self._server.serve_forever,
            name="weflow-channel-host-http",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        server = self._server
        if server is None:
            return
        server.shutdown()
        server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None

    def _handle_get(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._authorized(handler):
            _write_json(handler, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        parsed = urlsplit(handler.path)
        try:
            if parsed.path == "/api/v1/channel/events":
                query = parse_qs(parsed.query)
                after_cursor = query.get("afterCursor", ["0"])[0]
                limit_text = query.get("limit", ["100"])[0]
                page = self.event_store.pull(after_cursor, int(limit_text))
                _write_json(
                    handler,
                    HTTPStatus.OK,
                    {
                        "events": page.events,
                        "nextCursor": page.next_cursor,
                        "hasMore": page.has_more,
                    },
                )
                return
            if parsed.path == "/api/v1/status":
                process_alive = (
                    self.wechat_process_alive()
                    if self.wechat_process_alive is not None
                    else None
                )
                _write_json(
                    handler,
                    HTTPStatus.OK,
                    {
                        "host_alive": True,
                        "wechat_process_alive": process_alive,
                        "db_readable": self.event_store.readable(),
                    },
                )
                return
            if parsed.path == "/api/v1/channel/contacts":
                if self.contact_reader is None:
                    _write_json(
                        handler,
                        HTTPStatus.NOT_IMPLEMENTED,
                        {"error": "channel_contacts_unavailable"},
                    )
                    return
                query = parse_qs(parsed.query)
                after_cursor = query.get("afterCursor", [""])[0]
                limit = int(query.get("limit", ["100"])[0])
                page = self.contact_reader(after_cursor, limit)
                _write_json(handler, HTTPStatus.OK, page)
                return
            media_prefix = "/api/v1/channel/media/"
            if parsed.path.startswith(media_prefix):
                media_ref = unquote(parsed.path[len(media_prefix) :])
                if not media_ref or self.media_resolver is None:
                    _write_json(
                        handler, HTTPStatus.NOT_FOUND, {"error": "media_not_found"}
                    )
                    return
                try:
                    result = self.media_resolver(media_ref)
                except KeyError:
                    result = ChannelMediaReadResult.not_found()
                self._write_media(handler, result)
                return
            prefix = "/api/v1/channel/send-operations/"
            if parsed.path.startswith(prefix):
                operation_id = parsed.path[len(prefix) :]
                if not operation_id:
                    raise ValueError("operationId is required")
                operation = self.event_store.get_send_operation(operation_id)
                if operation is None:
                    _write_json(handler, HTTPStatus.NOT_FOUND, {"error": "not_found"})
                else:
                    _write_json(handler, HTTPStatus.OK, operation)
                return
            _write_json(handler, HTTPStatus.NOT_FOUND, {"error": "not_found"})
        except (TypeError, ValueError) as error:
            _write_json(
                handler,
                HTTPStatus.BAD_REQUEST,
                {"error": "invalid_request", "message": str(error)},
            )
        except Exception:
            _write_json(
                handler,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "channel_host_error"},
            )

    @staticmethod
    def _write_media(
        handler: BaseHTTPRequestHandler, result: ChannelMediaReadResult
    ) -> None:
        if result.state == "pending":
            _write_json(handler, HTTPStatus.ACCEPTED, {"error": "media_pending"})
            return
        if result.state == "not_found":
            _write_json(handler, HTTPStatus.NOT_FOUND, {"error": "media_not_found"})
            return
        if result.state != "ready" or not result.path or not result.mime_type:
            _write_json(
                handler,
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"error": result.error_code or "media_unreadable"},
            )
            return
        # The resolver owns media-type policy (images stay whitelisted there);
        # this boundary streams whatever the resolver validated.
        try:
            size = os.path.getsize(result.path)
            if size > 25 * 1024 * 1024:
                _write_json(
                    handler,
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {"error": "media_too_large"},
                )
                return
            handler.send_response(HTTPStatus.OK)
            handler.send_header("Content-Type", result.mime_type)
            # 缩略图回退标记：Core 侧据此将资产标记为可升级原图
            handler.send_header("X-Media-Variant", result.variant)
            if result.file_name:
                quoted = urllib.parse.quote(result.file_name, safe="")
                handler.send_header(
                    "Content-Disposition",
                    f"attachment; filename*=UTF-8''{quoted}",
                )
            handler.send_header("Content-Length", str(size))
            handler.send_header("Cache-Control", "private, no-store")
            handler.send_header("X-Content-Type-Options", "nosniff")
            handler.end_headers()
            with open(result.path, "rb") as stream:
                shutil.copyfileobj(stream, handler.wfile)
        except FileNotFoundError:
            _write_json(handler, HTTPStatus.NOT_FOUND, {"error": "media_not_found"})
        finally:
            cleanup = getattr(result, "cleanup", None)
            if callable(cleanup):
                cleanup()

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._authorized(handler):
            _write_json(handler, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        parsed = urlsplit(handler.path)
        if parsed.path == "/api/v1/channel/media-key/refresh":
            # 运维管理端点（不属于 Core 五契约）：显式刷新图片 AES 密钥。
            # 响应只含可用性，绝不回显密钥内容。
            if self.key_refresh is None:
                _write_json(
                    handler,
                    HTTPStatus.NOT_IMPLEMENTED,
                    {"error": "media_key_refresh_unavailable"},
                )
                return
            try:
                available = bool(self.key_refresh())
            except Exception:
                _write_json(
                    handler,
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "channel_host_error"},
                )
                return
            _write_json(handler, HTTPStatus.OK, {"available": available})
            return
        if parsed.path != "/api/v1/channel/send":
            _write_json(handler, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        try:
            length = int(handler.headers.get("Content-Length", "-1"))
            if length < 0 or length > 1_000_000:
                raise ValueError("request body size is invalid")
            body = json.loads(handler.rfile.read(length))
            operation_id, conversation_ref, payload = _parse_send_request(body)
            operation = self.event_store.create_send_operation(
                operation_id, conversation_ref, payload
            )
            _write_json(handler, HTTPStatus.OK, operation)
        except SendOperationConflict:
            _write_json(
                handler,
                HTTPStatus.CONFLICT,
                {"error": "send_operation_identity_conflict"},
            )
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            _write_json(
                handler,
                HTTPStatus.BAD_REQUEST,
                {"error": "invalid_request", "message": str(error)},
            )
        except Exception:
            _write_json(
                handler,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "channel_host_error"},
            )

    def _authorized(self, handler: BaseHTTPRequestHandler) -> bool:
        return handler.headers.get("Authorization") == f"Bearer {self.token}"


def _write_json(
    handler: BaseHTTPRequestHandler, status: HTTPStatus, value: object
) -> None:
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _parse_send_request(body: object) -> tuple[str, str, dict[str, object]]:
    if not isinstance(body, dict):
        raise ValueError("request body must be an object")
    operation_id = body.get("operationId")
    conversation_ref = body.get("conversationRef")
    payload = body.get("payload")
    if not isinstance(operation_id, str) or not operation_id.strip():
        raise ValueError("operationId is required")
    if not isinstance(conversation_ref, str) or not conversation_ref.strip():
        raise ValueError("conversationRef is required")
    if not isinstance(payload, dict) or payload.get("kind") != "text":
        raise ValueError("only text send operations are supported")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text payload is required")
    return operation_id, conversation_ref, {"kind": "text", "text": text}
