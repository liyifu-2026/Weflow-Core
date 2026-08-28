"""Backfill 真实环境演练脚本（前台一次性执行，采集统计日志证据）。

对全新 drill store 执行两轮完整 backfill：
  第 1 轮：真实回溯（统计 synthesized/inserted/elapsed + 每会话明细）
  第 2 轮：幂等复跑（inserted=0、duplicates=N，消息数不变）

等价于 host 启动时空库自动触发 + 手动 force 复跑的组合路径，
复用与 channel_host.main 完全相同的 BackfillRunner 代码。
"""
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent  # channel-host-wechat 目录由调用方指定
sys.path.insert(0, str(HERE))

from wechatauto import WeChatDB
from channel_host.event_store import EventStore
from channel_host.host import WeChatChannelHost
from channel_host.backfill import BackfillConfig, BackfillRunner

STORE = HERE / ".data" / "channel-host-drill.sqlite3"


def main() -> None:
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(STORE) + suffix)
        if p.exists():
            p.unlink()
    print(f"[drill] reset store: {STORE}")

    db = WeChatDB(
        db_dir=os.getenv("WECHAT_DB_DIR") or None,
        keys_file=os.getenv("WECHAT_KEYS_FILE") or None,
        account=os.getenv("WECHAT_ACCOUNT") or None,
    )
    store = EventStore(str(STORE))
    host = WeChatChannelHost(db, store, logger=lambda m: print(f"[host] {m}"))
    config = BackfillConfig(
        include_groups=False,
        since_days=0,
        batch_size=200,
        batch_delay_ms=500,
    )
    runner = BackfillRunner(
        host, store, config, logger=lambda m: print(f"[backfill] {m}")
    )

    assert store.is_empty_store(), "store should be empty before backfill"
    assert runner.should_auto_run(), "auto signal should be true on empty store"
    print("[drill] empty-store signal confirmed; starting backfill round 1")

    t0 = time.monotonic()
    stats1 = runner.run()
    print(f"[drill] round 1 wall time: {time.monotonic() - t0:.1f}s")
    print(f"[drill] round 1 summary: {stats1.summary()}")

    events = store.pull(limit=200)
    total = len(events.events)
    hist = sum(1 for e in events.events if e.get("historical"))
    print(f"[drill] store after round 1: events={total} historical={hist}")

    print("[drill] starting idempotent rerun (round 2)")
    stats2 = runner.run()
    print(f"[drill] round 2 summary: {stats2.summary()}")
    events2 = store.pull(limit=200)
    print(
        f"[drill] store after round 2: events={len(events2.events)} "
        f"(expect unchanged={total})"
    )
    assert len(events2.events) == total, "message count must not change"
    assert stats2.inserted == 0, "second run must insert nothing"
    print("[drill] PASS: idempotent rerun inserted 0, count unchanged")

    # 外发查证：backfill 全程绝不创建 send operation
    import sqlite3

    conn = sqlite3.connect(str(STORE))
    send_ops = conn.execute(
        "SELECT count(*) FROM channel_send_operations"
    ).fetchone()[0]
    conn.close()
    print(f"[drill] channel_send_operations rows after backfill: {send_ops}")
    assert send_ops == 0, "backfill must never create send operations"
    print("[drill] PASS: zero send operations")

    store.close()
    print("[drill] DONE")


if __name__ == "__main__":
    main()
