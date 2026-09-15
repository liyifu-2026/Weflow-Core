# ADR 0010：Channel 协议 v6——行为绑定权威 + eventKinds + conversationKind

- 状态：已接受（2026-09-09）
- 关联：ADR-0005（多账号隔离，additive 字段先例）、ADR-0006（群聊 reply/mention）、ADR-0007（历史回溯）

## 背景

`packages/contracts/src/channel.ts` 的 `CHANNEL_PROTOCOL` 是名义上的跨语言唯一权威
（生成 `channel_protocol.py` + CI `--check`），但行为绑定缺失，deletion test 判定它是
装饰品——删掉它行为不变，协议知识实际活在多份手抄里且已漂移：

1. Core zod（`http-channel-provider.ts`）手抄 sendKinds / sendOperationStates 枚举；
2. Host `outbound.py._SUPPORTED_SEND_KINDS` 残留协议 v3 已删除的 `"voice"` 死条目，
   且与 `http_host` 重复校验 payload 字段；
3. `event_store.py` 的状态机以 SQL 字面量书写，terminal 状态集手写；
4. `errorCodes` 号称"全集"，实际缺 8 个 Host 真实返回码
   （`account_mismatch`、`media_too_large`、`media_unreadable`、`unauthorized`、
   `backfill_unavailable`、`backfill_already_running`、`store_not_empty`、
   `media_key_refresh_unavailable`）；
5. **inbound 事件 kind 词汇（text/image/file/voice/emotion/pat/video）没有任何权威**：
   `ChannelEvent.kind` 是裸 `string`，Host if/elif 产出，Core 字符串匹配消费；
6. `@chatroom` 后缀（微信 wire 细节）在 Core 散布 6+ 处充当跨切枚举
   （turn-utils / decision-disposition / turn-runner / query-conversations /
   ingest-channel-events / contacts group-display-name），无符号拥有它。

## 决策

1. **权威行为绑定**：消费方一律从权威常量派生，不再手抄——
   - TS：zod 枚举从 `CHANNEL_PROTOCOL` 常量构造（`z.enum(CHANNEL_PROTOCOL.sendKinds)` 等）；
   - Python：`outbound.py` / `event_store.py` / `http_host.py` 校验从
     `channel_protocol.py` 常量构造（含 SQL 片段插值；terminal 状态集 =
     新增 `inFlightSendOperationStates` 的补集）；
   - `CHANNEL_PROTOCOL.errorCodes` 补全上述 8 个真实码。
   从此 deletion test 成立：删掉权威 = 两端行为崩，权威为真。
2. **协议 v6 内容（全 additive）**：
   - `errorCodes` 补全为真实全集（HTTP 层 8 码 + 发送层 payload/对账码，
     与 host 实际返回逐一对齐）；
   - 新增 `eventKinds: ["text","image","file","voice","emotion","pat","video"]`
     ——inbound 词汇入协议，Core zod 对事件 kind 做枚举校验（版本闸门保证
     两端一致后才会到达校验）；
   - `ChannelEvent` 新增可选 `conversationKind?: "private" | "group"`（Host 上报
     会话类型；取值沿用 Core 既有 chatType 词汇；缺省/null = 旧 Host，Core 回退推导）；
   - 新增 `inFlightSendOperationStates: ["pending","executing"]`（terminal =
     补集的派生依据，同时固化 "executing 对 Core 语义等价 pending" 的既有注释知识）。
3. **chatType 成为 Channel 事实（落库）**：`conversations` 加 `chat_type` 列，
   迁移对存量行按后缀一次性回填；ingest 时定一次（Host 上报优先，缺省时按
   `@chatroom` 后缀回退推导——**后缀知识从此收敛到 ingest 单点**）。全部消费点
   改读事实，不再从 ID 实时推导。这与 ADR-0005 的 `account` 字段同一模式：
   wire 细节的解释权归 Host，Core 消费通道中立事实。
4. **部署**：Core 与 Host 同步升 v6、一起重启；失配窗口内发送暂停是既有
   protocol mismatch 语义，不新做兼容层。

## 不覆盖

- Core 按 kind 的**语义分派**（媒体排队、占位符、转写触发）仍是手写 switch——
  那是消费逻辑，不是词汇权威；
- weflowctl doctor 继续作为进程外对账器（可与 Core 共享 contracts 比较助手，
  非强制）；
- 出站 `voice` 能力不恢复（v3/v5 裁剪决定不变）。

## 后果

- 协议一致性测试从"装饰文件同步"升级为行为断言；zod/Python 派生使字面量漂移
  在编译期/生成期即失败。
- 旧 Host 兼容：缺 `conversationKind` 时 Core ingest 回退后缀推导（仅此一处
  认识后缀），行为与今天一致。
- `conversations.chat_type` 迁移为 additive（journal 追加，不改写历史）。
- 未来非微信通道的会话 ref 不编码群属性时，链路依然成立（Host 上报为准）。
