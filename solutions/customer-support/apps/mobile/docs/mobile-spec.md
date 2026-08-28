# Mobile 开发规格

本文记录已确认的 Mobile 产品、交互和 Core 契约决策。Core 是业务事实来源；客户端不得用本地状态替代权限或 Handoff 归属裁决。

## 产品边界

- Mobile 的唯一产品目标是 Agent → Human Handoff：客服理解上下文、原子接手、人工回复并完成处理；知识、协作和联系人能力只能服务于当前会话，不能形成独立工作台。
- 仅内部客服使用，账号由 Core 管理；不支持注册、组织切换或用户输入 Core 地址。
- 支持 iOS 与 Android，手机竖屏优先；平板保持可用，不做专门分栏工作台。
- 首版不做主管强制转派、全文消息搜索、出站媒体、已提交消息的撤回或编辑。

## 会话与 Handoff

- Mobile Handoff Inbox 只返回通用人工队列、本人所属专业队列、本人正在处理的 Handoff，以及以本人为目标的 `TRANSFER_PENDING`；普通 Agent Conversation 不进入移动端。
- 唯一业务状态机为 `AGENT_ACTIVE → HANDOFF_PENDING → HUMAN_ACTIVE → HUMAN_FINISHED → AGENT_ACTIVE`；用户转交经过 `TRANSFER_PENDING`，队列转交回到 `HANDOFF_PENDING`。
- 无有效 Handoff 的会话只读，不提供隐式主动接管或直接发送；capability `mobileManualTakeover` 开启且会话为 AGENT_ACTIVE（无 handoff 行）时，提供显式「接管处理」入口，接管由 Core 原子裁决（`manual_taken_over`），失败（如他人已接管）立即刷新为服务端事实。
- Conversation 与 Handoff 分别使用 `conversationRevision` 和 `handoffRevision`；发送校验前者，接手、转交和结束校验后者。
- 每次责任转移结束旧 Cycle，并原子创建保存不可变 Structured Handoff snapshot 的新 Cycle；旧周期结果为 `transferred`。
- 接手、转交和结束均使用稳定 `clientRequestId`；响应丢失后必须先查询原请求 outcome，禁止生成新 ID 重试。
- 接手时取消未发送的 Agent 回复；已经发出的消息不撤回。`pending` 期间 Agent 暂停，新增客户消息进入记录并提醒客服。
- 转给具体客服后原 owner 立即失权，目标客服在 `TRANSFER_PENDING` 接受后才获得发送权限；拒绝或超时进入 Core 指定 fallback queue。
- 目标客服可以属于多个专业队列；`acceptBy` 与 `fallbackQueueId` 完全由 Core 决定。MVP 接受窗口为 15 分钟，拒绝或超时不退回原客服、不恢复 Agent。
- 转给专业队列后没有 owner，合法队列成员接手前 Agent 持续暂停。
- `结束人工处理` 只结束当前人工周期，不触发 Agent 主动回复；客户下一条新消息才重新由 Agent 处理。
- `customer_no_response` 只在人工最后一次出站后至少 30 分钟且客户没有新回复时自动推断；其他不明确结果由 `requiresConfirmation` 控制轻量确认。
- Core 在结束后异步生成 `resolutionSummary`，不阻塞结束、不要求客服确认。下一次 Agent 只继承结果、总结、最终事实、未解决事项和必要客户约束，不继承客服姓名或内部转交链。

## 信息名片与标签定向路由

- 客服可在「信息名片」自助更新头像、显示名（`displayName`，1-24 字符，可清空回落为登录账号）与专家标签（`tags`）。登录账号 `username` 不可修改；改密入口也在名片内。
- 标签词表 = Core 激活状态的专家队列（`GET /api/v1/auth/tag-vocabulary`，排除通用兜底队列），上限 7 个。资料更新走 `PUT /api/v1/auth/me`，校验与词表裁决完全由 Core 完成；标签与队列同源，保证一定可路由。
- 显示名优先于登录账号展示：Inbox 顶栏、人工消息头像、账号与设备页、转交列表等一切对客服身份的展示。
- Agent 转人工（`agent_recommended`）时，Core 按固定 intent→队列映射把任务定向路由到专家队列（`assignedQueueId`）；只有持有对应标签或属于该协作队列的客服可见、可认领、收到待认领通知。
- 定向路由任务 15 分钟无人认领时由 Core 自动解除队列限制，回落为全员可见并重发通知，保证任务不因缺少匹配客服而滞留。
- `agentProfile` capability 缺失（旧 Core）时隐藏显示名与标签编辑，头像与改密入口不受影响。Mobile 不缓存词表为事实：每次进入名片页重新拉取。

## 专业队列协作

Mobile 不再创建新的 Assist Request。存量只支持查看、提交意见、关闭和取消，直到清零。新的专业业务统一通过 ownership transfer 实现：

- **转给客服**：目标用户接受前处于 `TRANSFER_PENDING`，双方都不能发送。
- **转给专业队列**：进入 `HANDOFF_PENDING`，Core 根据队列成员资格裁决接手。
- 专业队列成员关系由 Core 管理，Mobile 不提供队列或成员管理。
- 转交需记录原周期、目标、可选转交说明、不可变结构化上下文、时间、fallback queue 和幂等键；转交说明为空时转交仍然允许。
- 队列成员领取必须由 Core 原子校验；客户端不得依据本地按钮状态判断成功。

### 存量 Assist Request

存量请求仍使用 `pending → claimed → answered → closed / cancelled` 状态，但 Mobile 不再显示新建入口。只保留查看、提交意见、关闭和取消既有请求所需的旧接口，直到存量清零。新专业队列业务必须使用 Handoff ownership transfer，不得降级成 Collaboration Request。

## WeKnora 知识辅助（仅会话内）

知识能力仍由 Core / WeKnora 提供，但 Mobile 不再暴露独立知识一级页面、资料库浏览、Wiki、收藏、历史线程或深度检索入口。客服只能在当前 Handoff 会话中请求建议，建议进入安全草稿后由人工编辑发送。

会话内建议使用证据优先的闭环：

```text
当前问题 → 检索证据 → 客服查看依据 → 生成建议草稿 → 客服编辑 → 主动发送
```

- Core 负责受控会话上下文、知识检索、证据权限和建议生成；Mobile 不直连 WeKnora，也不根据 Transcript 生成 Brief 事实。
- Suggestion 合同包含 `suggestionId`、`text`、`sourceRevision`、`generatedAt`、`evidenceIds[]` 和 `generationStatus`，其 revision 由 Core 确定。
- Conversation revision 改变后 Suggestion 立即 stale，不自动重新生成，也不得继续采用。
- 知识型建议必须有 Evidence；纯会话衔接类建议允许 `evidenceIds = []`，UI 显示“依据当前会话”。当时的 evidence snapshot 由 Core 保存审计。
- 建议生成默认检索租户全部非临时知识库（Mobile 未显式指定知识库时由 Core 解析）；寒暄等无相关内容时依据可为 0，属正常行为。
- Suggestion 被采用后才成为 Human Draft，草稿可由客服编辑，但永远不自动发送。

## 一致性、权限与审计

- 接手在同一事务中校验：周期仍为 `pending`、未分配、会话和账号有效、当前用户有权限，以及幂等键未执行；随后写入负责人、时间、版本、审计事件并抑制待发送 Agent 工作。
- 接手冲突返回 `409 handoff_already_claimed`，并附带当前 Handoff、负责人显示名和 `revision`，供 Mobile 立即刷新为只读。
- 服务端必须在人工发送、转交、结束人工处理，以及 Agent 出站发送前再次校验当前 Handoff 和负责人；前端禁用仅为体验优化。
- Agent 抑制须覆盖排队/运行中的 Turn、已生成草稿、未发出的出站消息、计划任务和重试任务。使用 `suppressed_handoff` 及关联的 Handoff ID 记录原因；已经送出的消息不可撤回。
- Handoff 事件与内部状态时间线由服务端产生，至少记录事件类型、操作者、周期、会话、前后状态、`clientRequestId`、时间和元数据。
- `clientRequestId` 的唯一性作用域为 `(user_id, operation_type, client_request_id)`；服务端保存请求哈希和首个响应快照。相同参数重放首个结果，不同参数复用返回 `idempotency_key_reused`。

## 对客与内部界面

- 对客消息不得提及“转人工”“智能客服”“Agent”或模型。Handoff 可发送自然衔接语，例如“稍等一下，我帮你问问。”；其文案由 Core 回复策略配置并幂等记录。
- 内部界面必须清楚区分客户、自动 Agent、人工客服、系统消息和状态事件。
- 会话详情默认加载最近 50 条，使用游标向上加载历史。刷新不得重置阅读位置；不在底部时以“有 N 条新消息”提示。
- 人工文本发送先显示“发送中”；服务端受理后显示“已受理/排队中”，最终状态以渠道真实回执为准。若渠道只能证明平台接收，显示“已发送”或“平台已接收”，不得承诺“已送达”。失败可用同一请求 ID 重试。
- 联系人资料只作为当前 Handoff 的次级上下文，不得扩展成 CRM、客户画像或销售工作台。

## 通知、缓存与安全

- 新 `HANDOFF_PENDING` 只通知有权访问通用队列或目标专业队列的客服（队列成员或持有对应名片标签）；负责人会话的客户新消息仅通知负责人。
- 默认通知显示联系人和状态，不显示消息正文；设置可开启预览或完全隐藏内容。Push 仅为提醒，App 必须重新请求 Core。
- `handoff_created`、`handoff_assigned`、`handoff_transferred`、`handoff_claimed`、`handoff_finished` 和 `customer_message` 事件只是 invalidate signal；Mobile 收到后立即 refresh，并以查询结果为唯一真实状态。
- 最近已查看会话可加密、按用户缓存；退出、禁用、改密或 Token 失效时清除。离线 owner 可编辑本地安全 Draft，但所有服务端写操作禁用。
- 使用可撤销的不透明 Bearer Token，仅保存于 Expo SecureStore；Preview / Production API 地址必须固定为 HTTPS，Development 明文 HTTP 只能显式开启。
- 未读、草稿和 Badge 均为用户级状态。服务端以 `(user_id, conversation_id, last_read_message_id, last_read_at)` 保存阅读游标，不只保存易失真的未读数。Badge 只统计待领取 Handoff 与当前负责人会话中的未读客户消息。
- 服务端保存跨设备一致的阅读游标；客户端可本地保存 `scroll_anchor_message_id` 和偏移量以恢复视觉位置。
- 错误监控只上传脱敏技术信息，禁止上传聊天正文、联系人资料、密码或 Token。

## 实现前补充约束

### 草稿与 revision

- 草稿按 `accountId + conversationId + handoffId` 隔离。切换账号时隐藏并锁定原账号草稿，不直接删除；重新登录原账号后可恢复。
- 明确退出并选择清除本机数据、账号撤销或安全会话失效时，删除该账号的草稿和离线缓存。
- 可发送草稿只能由当前会话负责人创建和编辑；非负责人在接手前不能预写可发送草稿。可编辑草稿必须带 `handoffId`。
- 草稿绑定 `baseConversationRevision`。revision 变化后进入 `stale_revision`，客服必须先查看新消息，或明确执行“已检查最新内容，继续使用草稿”；Core 记录 `reviewedAtRevision` 后才允许发送。
- MVP 草稿不跨端同步。其他端接手、转交或强制变更 Cycle 后，本机草稿归档为只读，可查看和复制但不可发送；当前 owner 必须明确丢弃旧草稿后才能开始新草稿。

### 发送结果

发送失败必须区分 `retryable_failed`、`rejected`、`permission_lost` 和 `outcome_unknown`。`outcome_unknown` 不得直接重发，必须先用原 `clientRequestId` 查询 Core 实际执行结果；Mobile 必须在本地安全存储中保留原请求 ID 和 `expectedConversationRevision`，使应用重启后仍无法绕过该闸门。

### 协助请求语义

协助请求状态为：

```text
pending → claimed → answered → closed
       ↘ cancelled
```

存量 Assist Request 被接手后发起人不能无条件取消。其 UI 使用“提交意见”“已答复”“关闭协助”，不与 Handoff 的“结束人工处理”混用。

队列成员领取前，在协作请求面板中只能看到 Core 专门生成的领取摘要，默认隐藏该请求的内部原因、联系方式和无关个人信息；这不限制会话本身的查看权限。所有有权访问该会话的客服仍可阅读完整文本时间线和必要的会话状态，用于判断是否适合领取。客户图片按媒体权限和网络状态加载，不因尚未领取而被隐藏。

`collaboration_request_participants` 只记录参与事实。最终权限必须综合请求类型、请求状态、参与关系、当前会话负责人关系和队列成员关系计算，不能仅依据 `participantType`。

### 本地缓存安全

- Mobile 首版最多缓存 20 个会话、总计不超过 100 KB；每个会话最多保存最近 20 条文本消息，消息缓存 24 小时后过期。超出数量或容量时优先淘汰最旧会话。
- 普通会话缓存只读；草稿使用独立生命周期，不因普通消息缓存过期而删除。
- 切换账号只隐藏并锁定原账号草稿和缓存；重新登录原账号可恢复。远程注销、账号撤销、安全会话失效或用户明确清除本机数据时删除。设置页必须把“切换账号”和“退出并清除本机数据”作为两个不同动作。
- App 进入后台时隐藏敏感预览；通知默认不展示完整客户内容。
- 加密数据不得进入未受保护的系统备份。
- 离线不缓存客户图片文件；图片消息只保留占位信息。Brief 与 transcript 缓存必须属于同一 conversation revision；离线禁止发送、接手、转交、结束和建议生成。

## Core V2 契约

| Current Behavior | Problem | Required Server Contract | Client Behavior | Fallback |
| --- | --- | --- | --- | --- |
| 新能力由 capability 声明 | Mobile 不能根据字段存在与否猜测支持度 | `GET /api/v1/mobile/capabilities` 返回 Mobile Handoff 能力集 | 只开启 Core 明确发布的能力 | 隐藏对应操作；不伪造兼容状态 |
| 专用 Inbox 只读取 Handoff 工作 | 普通 Conversation 过滤会泄露范围并伪造工作队列 | `GET /api/v1/mobile/handoffs/inbox` 完成队列权限、三类状态范围和业务排序 | 按返回顺序直接呈现 | capability 缺失时显示能力未开放，不读取普通会话 |
| Handoff 详情与 Transcript 独立刷新 | 单一错误不能被误判为没有 Handoff | 查询返回标准状态、owner、`handoffRevision`、Cycle 和 Structured Brief | 错误隔离；只有责任区变为只读 | Brief 失败显示“交接摘要暂时不可用”，仍可接手 |
| 接手、拒绝、转交和结束均为原子操作 | 客户端本地 owner 或乐观更新会造成双写 | 每个写操作接受 `expectedHandoffRevision` 和 `clientRequestId` | 响应成功后才应用新归属；冲突直接 refresh | 状态无法确认时整个责任操作区只读 |
| 转交确认使用 Core 快照 | Mobile 不能从 Transcript 重写交接事实 | 目标用户/队列列表、`transfer-preview`、不可变 Transfer Context、fallback 与 timeout | 可选 `transferReason`（空则省略），三步内确认 | 预览失败仅阻止转交，不影响回复 |
| 结束人工处理尽量自动推断结果 | 固定长表单会牺牲处理速度 | `finish-context` 返回 `inferredResult`、`confidence`、`requiresConfirmation` | 仅 `requiresConfirmation = true` 时询问轻量结果 | 推断上下文失败时不允许猜测结束 |
| Suggestion 与 Draft 分离 | 旧 action output 无法保证 revision 和 Evidence 安全 | Core 返回标准 Reply Suggestion 与 Evidence snapshot | 过期只能重新生成；采用后才进入 Draft | capability 缺失或生成失败时隐藏建议能力 |
| Push / realtime 仅作为 invalidate signal | 事件本身可延迟、重复或乱序 | 事件携带资源 ID；outcome 端点可查原请求 | 立即 refresh，前台轮询作为 safety net | UNKNOWN 期间保留原 ID 并锁住冲突操作 |

1. 移动端 Bearer Token 登录、认证、注销与撤销。
2. 条件更新实现原子接手；冲突返回 `409 handoff_already_claimed` 与负责人摘要。
3. 服务端校验当前 owner 才能发送、转交或结束人工处理，且一个 Handoff 任何时刻最多一人拥有发送权。
4. 支持用户转交的 `TRANSFER_PENDING` 接受、拒绝、超时和 fallback，以及队列转交的 `HANDOFF_PENDING`；每次责任转移原子结束旧 Cycle 并创建不可变新快照。
5. 提供专用 Mobile Handoff Inbox，只返回合法队列中的 `HANDOFF_PENDING`、当前用户的 `HUMAN_ACTIVE` 和以其为目标的 `TRANSFER_PENDING`，并由 Core 完成业务排序。
6. 提供未读、设备注册、Push Outbox 和投递审计。
7. 固定机器可读错误码，例如 `handoff_already_claimed`、`handoff_not_assignee`、`handoff_revision_conflict`、`idempotency_key_reused`、`token_expired` 与 `account_disabled`；客户端不得依赖中文错误文案分支。
8. 以集成测试覆盖抢单竞争、权限绕过、幂等发送、状态刷新、Token/缓存失效，以及接手与 Agent 出站并发。
9. 提供专业队列和可接手客服目标、结构化 Transfer Context 预览、原子转交、通知与完整 Cycle 审计。
10. 提供 revision-bound Suggestion 和 Evidence snapshot 契约；建议与 Human Draft 分开存储和审计。
11. 提供发送结果查询能力，支持 `outcome_unknown` 在原 `clientRequestId` 下查询实际执行结果。
12. 对 revision 变化、`reviewedAtRevision`、协助请求领取摘要和参与者权限计算提供服务端事实与审计。
13. Handoff 查询返回结构化 Brief：`problemSummary`、`confirmedFacts[]`、`triedSteps[]`、`missingInformation[]`、`unresolvedItems[]`、`handoffReason`、`suggestedNextStep`、`suggestedFirstReply`、`sourceConversationRevision`、`generatedAt`。Mobile 不从消息或 Case 状态自行拼接这些内容。
14. 提供 capability 合同。Core 新能力不存在时 Mobile 隐藏对应操作，不伪造兼容状态。
15. 结束后创建异步 `resolutionSummary` 任务；Human → Agent 上下文只投影业务结果、总结、最终事实、未解决事项和必要客户约束。
16. Brief 支持弱质量反馈，人工消息支持次级“需复盘”反馈；反馈不改变责任状态。

## 数据边界与后续演进

- 会话列表只返回联系人、最后消息摘要、Handoff、负责人、未读数和发送状态；完整记录仅在进入会话后分页获取。
- 历史分页使用稳定排序键（如 `(occurredAt, messageId)`）和 `before` 游标；实时增量使用单独的 `after` 游标，避免混用方向。
- 首版移动端使用前台 15 秒轮询作为实时增量的临时实现；后台停止，回到前台立即刷新。后续若使用 Push 或 WebSocket，仍必须复用 revision 和 Core 权限裁决。
- 唯一 Handoff Inbox 和打开的会话使用同一个刷新信号；Push 到达时立即刷新，前台 15 秒轮询兜底，后台停止。
- 图片消息只通过带 Bearer Token 的 Core Media 内容接口加载；Core 必须确认媒体仍关联有效会话。Mobile 不保存媒体文件到离线缓存。
- 人工接手关闭自动 Agent 回复，但不预设关闭未来的内部 AI 辅助能力。后续可区分 `auto_agent_enabled` 与 `human_assist_enabled`，例如草拟回复、会话摘要或知识推荐。
- 存量 Assist Request 继续使用独立模型；新的专业队列升级必须进入 Handoff ownership transfer，不得创建 Collaboration Request。
- 缓存还应在账号切换、远程注销、权限撤销或本地加密密钥不可用时清除；缓存密钥依赖 Keychain/Keystore，不与普通数据共存。

## MVP 端到端验收场景

1. Agent 普通转人工：Inbox 出现结构化 Brief，接手后才出现 Composer。
2. 高风险转人工：顺序由 Core 提供，Mobile 不显示技术优先级。
3. 两客服竞争：只有一人原子接手，失败者刷新为只读。
4. 转给具体客服并接受：原 owner 立即失权，目标接受后才可发送。
5. 转给具体客服拒绝或超时：进入 Core fallback queue，不退原客服、不恢复 Agent。
6. 转专业队列：仅合法成员可见并领取，未领取期间没有 owner。
7. 转交途中客户追加消息：旧预览因 revision 冲突失效，刷新后重新确认。
8. 人工结束后客户再次发消息：Agent 接续受控结果与总结，不包含客服身份和内部转交链。

开发顺序已经进入 Core V2 合同与上述八个场景的持续回归；Mobile 只在 capability 明确存在时开启对应写操作。
