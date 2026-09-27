# 03 · Core 引擎后端

> 出处：`core/`（模块源码）、`core/AGENTS.md`、`core/CONTEXT.md`、`core/docs/adr/0001–0015`。

## 1. 定位与分层

`core/` 是引擎层（无界面业务核心）：**不加业务语义**（业务策略/话术/状态机归 `solutions/`），
可以有业务中立的机制状态（handoff 状态机、定时发送队列、群聊线程等）。

技术栈：TypeScript 5.9（ESM）+ Fastify 5.10 + Drizzle ORM 0.45（PostgreSQL 16）+
BullMQ 5.81（Redis）+ zod 4.4（输入校验）+ argon2（密码）+ pino（日志）。
包名 `@weflow/core`（private），engines `node >=24 <25`。

目录形状：

```
core/
├── apps/            # 三个进程入口：api / agent-worker / ingestion-worker
├── modules/         # 17 个领域模块（interface / application / contracts 分层）
├── infrastructure/  # postgres、redis、http、model_runtime、knowledge、events、file_storage…
├── migrations/      # 77 个编号 SQL 迁移（0000–0080）+ drizzle journal
├── scripts/         # create-user / reset-password / promote-admin / check-migration-journal…
└── tests/           # 126 个测试文件（48 个真库集成测试）+ setup.ts
```

**模块结构强制**（`core/AGENTS.md`，机械检测见根 AGENTS §7.3）：

- 有 `interface/` 路由的模块必须有非空 `application/`。
- 路由处理器只允许：鉴权（`requireBusinessIdentity`/`requireAdminIdentity`）→ zod 校验 →
  委托 application 层 → 映射 HTTP 响应。
- **禁止**：路由直接 import `infrastructure/postgres/schema` 或调用 Drizzle；
  application 层依赖 Fastify request / 环境变量 / provider 私有 payload；动态 import `tooling/`。

## 2. 三个进程入口

| 进程 | 端口 | 启动（dev） | 职责 |
|------|------|------------|------|
| core-api | `CORE_PORT`=3100 | `pnpm dev:api`（tsx watch） | 路由 + SSE + 静态托管 + 四轮询器 + 全部 dispatcher |
| agent-worker | `AGENT_WORKER_HEALTH_PORT`=3101 | `pnpm dev:agent-worker` | `agent-turns`、`memory-capture` 队列消费；`AGENT_WORKER_CONCURRENCY`（默认 3）全局并发、每会话串行；模型设置热加载 |
| ingestion-worker | `INGESTION_WORKER_HEALTH_PORT`=3102 | `pnpm dev:ingestion-worker` | `media-processing` 队列消费；`MEDIA_PROCESSING_CONCURRENCY`（默认 1）防多模态过载 |

常用 scripts：`build`、`check`（migrations+format+lint+typecheck+test）、`check:migrations`、
`migrate` / `migrate:prod`、`create-user`、`reset-password`、`promote-admin`、`converge:legacy-media`、
`test`（vitest run --no-file-parallelism）、`typecheck`、`lint`、`format:check`。

## 3. 模块清单（17 个）

> 路由基址统一 `/api/v1`。完整端点表见 05 章，此处讲职责与关键实现。

### 3.1 agent — Agent 回合编排（核心模块）

- **职责**：Turn 执行接缝、决策契约、策略闸门、工具目录、会话（Episode）、自唤醒、定时发送、
  群聊策略、Triage 分流、轮窗、事实卡、重复回复防护。
- **关键文件**（`core/modules/agent/application/`）：
  - `agent-turn-executor.ts`：执行接缝（ADR-0001），Worker 只管队列消费/能力注入/进程生命周期。
  - `decision-contract.ts`：决策动作 9 值 + 14 字段契约单点定义。
  - `decision-disposition.ts`：**双路径共享处置单点**（fresh=`processAgentTurn`、
    tool_recovery=`processPlannedToolTurn` 统一经 `commitDecisionDisposition()`）；
    含吸收式回合裁决矩阵 `absorbVerdictFor`（见 06 章 §5）。
  - `policy-gate.ts`：策略闸门（`requiresHuman || riskLevel==='high' || nextAction==='handoff'`
    → 强制 handoff；回复 1~8 段、每段 ≤500 字校验；批内重复段去重）。
  - `tool-catalog.ts`：工具注册表（4 个只读工具，见 06 章 §4）。
  - `duplicate-reply.ts` + `reply-text.ts`：重复回复防护（整批复读判定 + 顺序无关批次指纹
    `replyFingerprint` + `dropSegmentsDuplicateOfLastReply` 告别语逐段剔除）。
  - `agent-session.ts`：会话片段（Episode）与群聊线程三函数；`session-wake.ts`：wait 唤醒。
  - `scheduled-sends.ts`：定时发送（护栏：pending 上限 2、每日上限 10、静音 22:00–08:00 顺延）。
  - `group-chat-policy.ts`：群聊准入策略；`triage-classifier.ts`：Triage 分流。
  - `round-window.ts`：轮窗（20 条外更早回合压摘要行，最多 4 行、72h 窗）。
  - `conversation-facts.ts`：会话事实卡（`fact_cards` 表，整体替换语义，落库失败静默）。
  - `agent-turn-outcome-command.ts`：事务化 Outcome Command（Turn/消息/Handoff/记忆调度原子提交）。
  - `agent-turn-failure-coordinator.ts`：失败协调（如截断转人工）。
- **contracts**：`agent-skill.ts`（SkillRegistry 契约，机制在、允许空置）、
  `execution-strategy.ts`（ExecutionStrategy 契约 + Registry，业务插件注册）。
- **路由**（`interface/scheduled-send-routes.ts`）：定时发送列表/取消/改期/立即发（见 05 章 §5）。

### 3.2 assets — 素材空间

上传即持久持有（`assets.items`，image/file 分类）、搜索/改名/软删；发送时按
「素材 + 会话 + clientRequestId」**确定性派生 mediaId** 走既有出站链路，文件不重复上传。

### 3.3 channel — 通道契约（无路由）

`channel-wire.ts`、`channel-event-source.ts`、`channel-media-source.ts`、`channel-send-operations.ts`、
`channel-contact-source.ts` 五接缝 + `contracts/`（re-export shim，权威在 `@weflow-leaif/contracts`）。
协议适配器在 `infrastructure/channel/http-channel-provider.ts`。

### 3.4 collaboration — 协作（存量收尾）

专家队列 / 协助请求（assist）/ 升级请求（escalation），认领/答复/关闭/取消均幂等。
手机端已不再新建（新业务统一走 Handoff transfer），端点保留做存量只读收尾。

### 3.5 console-events — 会话事件流

`GET /api/v1/console/events/stream`（SSE）；事件总线 `infrastructure/events/conversation-events.ts`
（ADR-0009，见 02 章 §5）。

### 3.6 contacts — 联系人档案

备注/标签/共享别名/头像代理/`agent_enabled`（黑名单制，默认 true）/`scheduled_send_enabled`（默认 false）/
`blocked`（拉黑）；`channel-identity.ts` 派生稳定 ID（`contact:channel:account:contactId`）；
`sync-channel-contact-profiles.ts` 从 Host 同步；头像代理带域名后缀白名单
（`AVATAR_ALLOWED_HOSTS`，不配置 = 一律拒绝）。

### 3.7 conversations — 会话与消息（主链路）

- `ingest-channel-events.ts`：入站幂等摄取；`historical` 事件零副作用（回溯不入 Agent/记忆/通知/转写）；
  未知客户占位 `UNKNOWN_CUSTOMER_TEXT = "（未知客户）"`（ADR-0013 引擎内嵌）；新入站取消 pending 定时发送与唤醒。
- `turn-admission.ts`：合并窗口（普通 12s、半句启发式 30s）+ `turn_admission_states` CAS 认领。
- `process-outbound-messages.ts`：出站发送循环；`outbound-step-decision.ts`：发送期插话闸门（ADR-0012，
  命中则本段及剩余分段置 `held`，事件 `reply_interrupted` 每批至多一次）。
- `send-states.ts`：8 态发送状态唯一权威（见 02 章 §4）。
- `create-manual-reply.ts`：人工回复（clientRequestId 幂等；媒体/素材/引用/@提及）。

### 3.8 handoff — 人工转接（详见 06 章 §8）

`mobile-handoff-service.ts` 状态机 + 幂等操作重放（`handoff.events` 存 request_hash + response_snapshot）；
`handoff-briefing.ts` 结构化简报（v1/v2）；`handoff-reminder.ts`（pending 超 120s 且配置了话术时代发轻提示，
缺省空=关闭）；`route-media-to-human.ts`（Handoff 中入站媒体转人工）。

### 3.9 identity — 身份认证（详见 14 章）

登录（Web Cookie 12h / 移动长 TTL）、argon2、登录限流（10 次/15 分钟双维度）、用户管理、
头像（上传/DiceBear 预设/按显示名稳定分配）、专家标签词表（`tags` = 队列 key，转人工定向路由用）。

### 3.10 knora-bridge — WeKnora 桥接

weflow 用户 → WeKnora 用户代管登录：合成邮箱（`KNORA_ACCOUNT_EMAIL_DOMAIN`）+ AES-256-GCM 加密凭证
（`knora_accounts` 表，`KNORA_ACCOUNT_ENC_KEY` 缺失时路由 503）；一次性 code 换短期令牌，
302 跳转 WeKnora UI（`WEKNORA_ORIGIN`）。

### 3.11 knowledge — 客户端知识服务

知识会话线程（WeKnora session 映射）、检索、基于证据的草稿、用户×会话证据托盘、反馈、
文档/FAQ/Wiki 浏览、流式直答（`POST /knowledge/answer/stream` + stop）、`suggestion-sanitizer.ts`
（建议回复消毒）。admin 检索设置 `GET/PUT /admin/retrieval-settings`。

### 3.12 knowledge-provider — 知识引擎代理

浏览器只持 Weflow Cookie，对 WeKnora 控制面的**白名单代理**（`boundary.ts` 路径/方法白名单 +
`MAX_KNOWLEDGE_UPLOAD_BYTES` 上传上限；`provider-proxy.ts` 转发 + 变更审计）。
上游地址/Key/内部错误不出 Core。新改动：代理流改用 `responseBodyStream`（见 §5 未提交改动）。

### 3.13 media — 媒体管道（详见 06 章 §9）

同步下载、图片描述、语音转写、原图升级、非 inbound 终态化、元数据/内容服务（ETag=sha256 + 304、
RFC5987 中文名）、人工出站上传（≤100MB multipart、类型黑名单 415）。

### 3.14 memory — 记忆

90s 安静窗口调度（`MEMORY_QUIET_WINDOW_MS=90_000`）、LLM 提取（fact/preference/relationship，
每批 ≤10 条，敏感/不稳定/非明确不进召回）、召回 12 条（importance desc → updatedAt desc，
召回回写 `last_recalled_at`）、人工管理（创建/失效/确认）。

### 3.15 model — 模型契约（无路由）

`text-model.ts`、`text-generation-request.ts`（含 `TextToolDefinition` FC 协议与 `thinking` 控制）、
`text-generation-result.ts`、`text-model-error.ts`。实现适配器在 `infrastructure/model_runtime/`
（OpenAI 兼容客户端、Mimo 视觉/音频客户端、**热加载客户端**——消费 DB 模型注册表 15s 轮询）。

### 3.16 notifications — 通知

移动推送设备注册（`notification.devices`，push_token 唯一，`notify_kinds` NULL/空=全部订阅）+
通知 outbox（dedupe_key 唯一）+ `infrastructure/notifications/expo-push-dispatcher.ts`（Expo Push）。
**Push 是提醒不是业务事实**：收到后必须回拉 Core。

### 3.17 operations — 运营控制面

系统状态（`buildSystemStatus(services)`：configuration × health 矩阵）、admin 总览、审计查询、
Agent Turn 诊断查询、runtime-settings（不重启调行为 + 回滚 + 审计）、**统一模型注册表/网关**
（`model_registry` 表：capabilities text/vision/asr、protocol `chat_inline|audio_transcriptions`、
`failover_to` 单跳故障转移指针 + 解析层防环；五槽位 text/vision/asr/triage/fast；测试连接端点）、
扩展设置（`extension_settings` 读写）、admin SSE 流。

## 4. ADR 决策速览（`core/docs/adr/0001–0015`）

| ADR | 标题 | 一句话决策 |
|-----|------|-----------|
| 0001 | Agent Turn Execution Seam | 一切 Turn 经 `AgentTurnExecutor.execute()`；DB 是跨进程并发权威（CAS + 乐观锁 + 工具租约 5min） |
| 0002 | 平台 Agent 闭环——策略与技能由插件提供 | 策略/Skill 不内置 Core；Core 是闭环事实唯一来源；知识证据只回投影公开字段 |
| 0003 | Solution Pack Foundation | **已 Superseded**（R3 拆除安装体系，改目录直读；留作历史） |
| 0004 | Case-facts 持久化能力整体移除 | `case_states` 表已删（0056 迁移）；结构化事实必须走插件 seam |
| 0005 | 多微信账号隔离 | `ChannelEvent.account` + `channel_account` 列（默认 default），联系人唯一键三维 |
| 0006 | 群聊引用回复与 @ 提及 | send kind 加 reply/mention/poke；群聊响应策略进 `group-chat-policy.ts` |
| 0007 | 空库历史回溯 | 回溯在 Host 侧完成；`historical` 事件 Core 照常入库但零副作用；回溯前先占坑水位 |
| 0008 | 知识库配置统一 | 设置中心唯一界面入口，env 兜底逐项回落；30s 热加载；留空自动发现 |
| 0009 | 会话事件跨进程扇出 | 本地投递 + Redis 广播 + origin 防回环；事件只是失效信号；降级进程内 |
| 0010 | Channel 协议 v6 | `CHANNEL_PROTOCOL` 唯一权威（TS 常量 → Python 派生）；`chat_type` 落库，删散布的 `@chatroom` 判断 |
| 0011 | 业务缺省出引擎——产品仓种子机制 | 引擎缺省中立（botNames=[]、轮窗标签 customer/assistant）；业务缺省由部署种子写入，只补缺不覆盖 |
| 0012 | 发送期插话闸门 | 分段发送途中每段前检查新入站；命中 → 剩余段落 `held` + `reply_interrupted` 事件 |
| 0013 | 入站发送者占位文案保持引擎内嵌缺省 | `"（未知客户）"` 留在引擎（同步净化路径内；历史消息不可变） |
| 0014 | 业务子树迁移搭乘引擎迁移列车 | `0061` 迁移建 `customer_support` schema——单进程单库产品，保留现状 |
| 0015 | 行为设置命名空间由部署配置绑定 | 五处设置读取的命名空间由 `BEHAVIOR_SETTINGS_REF` 绑定；未配置 = 纯平台模式 |

## 5. 当前未提交改动（工作树，将随 v1.2.0 入库）

主题一：**重复回复防护升级**（2026-09-23 X230 实测驱动）
- `reply-text.ts` 新增 `replyFingerprint(text)`：按空行拆段、逐段归一化后**排序重拼**——
  解决「同几句话换个顺序再说一遍」绕过整批复读判定的问题。
- `duplicate-reply.ts`：判重改顺序无关批次指纹；新增 `dropSegmentsDuplicateOfLastReply`
  （逐段剔除与上一条已送达批次重复的分段）。
- `decision-disposition.ts`：handoff 告别语复读守卫——模型转接时把刚说过的话（含换序）当告别语
  是高频行为；现逐段剔除，全重复则静默转接。

主题二：**X230 生产事故修复固化**
- `infrastructure/http/response-body.ts`（新文件）：`responseBodyStream()`——fetch 响应体转 Node 流，
  带 8MB 预读缓冲。修复 Node 24.21 undici 事故：消费端一慢解析器暂停，若对端发 FIN，
  `Parser.finish()` 命中 `assert(!this.paused)` 未捕获断言**直接终止整个 api 进程**
  （X230 连崩 125 次、媒体全部不可见）。使用方：sync-channel-media、upgrade-channel-image-originals、
  knowledge-provider 代理（三处替换裸 `Readable.fromWeb`）。
- `media/application/terminalize-non-inbound-media.ts`（新文件）：outbound/unknown 方向媒体此前
  停在 `processing_queued` 被 dispatcher 每秒重投空转（X230 实测 3 张自消息图片空转数小时）；
  现置 `ready` 终态（无描述/转写、不建 Turn，不写 errorCode——这不是失败）。
- 配套测试：`channel-media-processing.integration.test.ts`（+72 行）、`decision-disposition.test.ts`（+67）、
  `duplicate-reply.test.ts`（+35）、`non-inbound-media.integration.test.ts`（新）、
  `response-body-stream.test.ts`（新）。
