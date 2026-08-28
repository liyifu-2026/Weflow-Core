"""回归演练：往 drill store 注入一条「实时」事件（无 historical 标记），
验证 Core 实时摄取路径的副作用正常触发（对照 191 条历史消息的零副作用）。"""
import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

STORE = r"C:\Users\12991\Desktop\We\weflow\runtimes\channel-host-wechat\.data\channel-host-drill.sqlite3"

conn = sqlite3.connect(STORE)
try:
    now = datetime.now(timezone.utc).isoformat()
    conv = "wxid_e2e_regression"
    event_id = f"wechat:{conv}:902"
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        """
        INSERT OR IGNORE INTO channel_events (
            event_id, conversation_ref, channel_message_id,
            sender_ref, kind, content, occurred_at, observed_at,
            is_self, media_ref, file_name, mime_type, account,
            source_metadata, mentioned, reply_to_channel_message_id,
            historical
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (
            event_id,
            conv,
            "902",
            conv,
            "text",
            "回归测试第二条实时消息",
            now,
            now,
            0,
            None,
            None,
            None,
            "wxid_gd6fxg4wqakd22_404c",
            None,
            None,
            None,
        ),
    )
    conn.execute(
        """
        INSERT INTO source_checkpoints (conversation_ref, sort_seq)
        VALUES (?, 901)
        ON CONFLICT(conversation_ref) DO UPDATE SET sort_seq = 901
        """,
        (conv,),
    )
    conn.execute(
        """
        INSERT INTO discovered_conversations (
            conversation_ref, discovery_key, discovered_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_ref) DO UPDATE SET
            discovery_key = excluded.discovery_key,
            updated_at = excluded.updated_at
        """,
        (conv, "message-chat:901", now, now),
    )
    conn.execute("COMMIT")
    print(f"injected live event {event_id} (historical=0)")
finally:
    conn.close()
