# 排错速查（日志 / 决策轨迹 / 轮次体检）

> 目标：任何一轮对话出问题，30 秒内分辨「没收到 / 已读不回 / 失败」并找到原因，不再翻原始日志。

## 三类问题怎么分

| 现象 | 判定 | 数据源 |
|------|------|--------|
| 没收到 | 入站消息没有触发任何 turn（孤儿消息） | 前端 Inspector「轮次体检」的 ✉️ 未触发 计数；SQL 见下 |
| 已读不回 | turn 存在但 outcome=no_reply（suppressed/no_action，errorCode 是原因） | 体检列表「未回复 xxx」/ 回合气泡黄点 |
| 其他错误 | outcome=failed（errorCode 如 retry_exhausted / model_request_failed） | 体检列表「失败 xxx」/ 回合气泡红点 + 轨迹抽屉红色横幅 |

## 前端入口

- **轮次体检**：会话页右侧 Inspector → 上下文视图顶部（✅/😶/⚠️/✉️ 四类计数 + 最近 6 轮列表 + 孤儿消息提示），点任意条目直接打开该轮决策轨迹。
- **回合气泡**：消息流里每轮 AI 回合有「AI 接手处理」胶囊（开始）与「回合完成 · 耗时」胶囊（结束）；未回复/失败轮在开始胶囊上直接标红/黄。点「决策轨迹 →」看全过程。
- **决策轨迹抽屉**：事件中文时间线 + 每步相对耗时 + 总耗时 + **模型思维链**与**模型原始输出**折叠块 + 失败横幅。

## SQL 速查（psql / 任意客户端，连 core 库）

```sql
-- 1) 某轮完整轨迹（含模型原文/思维链）
SELECT event_type, reason_code, payload, created_at
FROM agent.turn_events WHERE turn_id = '<turnId>' ORDER BY created_at;

-- 2) 近 24h 失败轮次
SELECT turn_id, conversation_id, error_code, created_at
FROM agent.turns
WHERE status = 'failed' AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;

-- 3) 近 24h 孤儿入站消息（没触发任何 turn = 「没收到」）
SELECT m.message_id, m.conversation_id, m.content_type, m.occurred_at
FROM conversation.messages m
WHERE m.direction = 'inbound' AND m.occurred_at > now() - interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM agent.turns t WHERE t.trigger_message_id = m.message_id)
ORDER BY m.occurred_at DESC;
```

## 事件类型新增（本轮可观测性改造）

- `turn_error`：轮次执行抛错（重试前落库；payload.message 是错误原文前 500 字）
- `turn_failed`：队列重试耗尽等终态失败（payload.handoffReason）
- `model_call.payload.modelOutput`：模型原始输出前 2000 字（排查「该回没回」直接看原文）

## 服务日志位置（Windows 服务 / WinSW）

- `weflow/tools/winsw/logs/weflow-agent-worker.out.log`（结构化 JSON）
- `weflow-agent-worker.err.log` / `weflow-core-api.*.log` 同目录
- 服务控制需管理员：`sc query/stop/start weflow-agent-worker`（或 weflowctl service restart）

## 模型/槽位配置

- 槽位绑定：`operations.runtime_settings` 的 `model_slot_text/fast/triage/vision/asr`
- 模型注册（baseUrl/apiKey/capabilities）：`operations.model_registry`
- text 槽位模型需具备 `vision` 能力标签，图片直读才会注入（见 `apps/agent-worker/main.ts`）
